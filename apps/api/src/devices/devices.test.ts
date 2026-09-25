import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDev } from '../db/seed';
import { loadPrincipal } from '../principal';
import { createTestApp, login, truncateAll, type Client, type TestApp } from '../test/helpers';
import { DeviceDenied } from './broker';
import { WorkerSimulator } from './simulator';

/**
 * M4 — protokół Workera na symulatorze: parowanie, uwierzytelnienie, granty, odmowy po obu stronach,
 * idempotencja, odwołanie, zapis z podglądem diff i zgodą. Wszystko w katalogach fixture (tmp).
 */
let t: TestApp;
let base: string;
let alfa: Client;
let beta: Client;
let fx: string; // katalog fixture (udostępniony)
let outside: string; // katalog poza udostępnieniem
let state: string;
let sim: WorkerSimulator;

beforeAll(async () => {
  t = await createTestApp();
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => t.close());

beforeEach(async () => {
  await truncateAll(t.db);
  t.seed = await seedDev(t.db, 'test');
  alfa = await login(t.app, 'alfa');
  beta = await login(t.app, 'beta');
  const root = await mkdtemp(join(tmpdir(), 'nova-dev-'));
  fx = join(root, 'projekt');
  outside = join(root, 'poza');
  state = join(root, 'state');
  await mkdir(fx);
  await mkdir(outside);
  await writeFile(join(fx, 'notatka.txt'), 'wersja 1\n');
  await writeFile(join(outside, 'tajne.txt'), 'SEKRET POZA KATALOGIEM');
  sim = new WorkerSimulator(
    base,
    { roots: [fx], capabilities: ['device.files.read', 'device.files.write', 'device.git.read'] },
    state,
  );
});
afterEach(async () => {
  sim.close();
  // Poczekaj, aż serwer obsłuży zamknięcie (zapis last_seen / zdarzenie statusu).
  for (let i = 0; i < 50 && sim.deviceId && t.deps.devices.hub.isOnline(sim.deviceId); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 30));
});

async function pairAndConnect(c: Client = alfa) {
  const code = (await c.post('/api/devices/pairing-codes')).body.code as string;
  await sim.pair(code, 'Laptop testowy');
  await sim.connect();
  return sim.deviceId!;
}

async function grant(deviceId: string, capability: string, root = fx, c: Client = alfa) {
  const r = await c.post(`/api/devices/${deviceId}/grants`, { capability, root });
  expect(r.status).toBe(201);
  // Poczekaj na podpisane granty w Workerze.
  for (let i = 0; i < 50 && !sim.grants.some((g) => g.capability === capability); i++)
    await new Promise((r) => setTimeout(r, 10));
  return r.body.id as string;
}

async function exec(
  userKey: 'alfa' | 'beta',
  deviceId: string,
  capability: any,
  params: Record<string, unknown>,
  key = `k-${Math.random()}`,
) {
  const principal = (await loadPrincipal(t.db, t.seed.users[userKey]))!;
  return t.deps.devices.execute(principal, 'private_agent', deviceId, capability, params, {
    taskId: null,
    idempotencyKey: key,
    correlationId: 'test',
    timeoutMs: 3000,
  });
}

async function chat(c: Client, content: string, space: 'private' | 'shared' = 'private') {
  const conv = (await c.post('/api/conversations', { space })).body;
  await c.post(`/api/conversations/${conv.id}/messages`, { content });
  await t.drain();
  return {
    conv,
    msgs: (await c.get(`/api/conversations/${conv.id}/messages?limit=100`)).body.items as any[],
  };
}

describe('parowanie i połączenie', () => {
  it('kod jednorazowy paruje urządzenie z właścicielem; Beta go nie widzi', async () => {
    const code = (await alfa.post('/api/devices/pairing-codes')).body.code as string;
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const pr = await sim.pair(code);
    expect(pr.serverPublicKey).toBe(t.deviceServerPublicKey.toString('base64'));
    await sim.connect();
    const list = (await alfa.get('/api/devices')).body.items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Symulator', status: 'active', online: true });
    expect((await beta.get('/api/devices')).body.items).toHaveLength(0);
    expect(
      (
        await beta.post(`/api/devices/${pr.deviceId}/grants`, {
          capability: 'device.files.read',
          root: fx,
        })
      ).status,
    ).toBe(404);
    // Kod nie działa drugi raz.
    const other = new WorkerSimulator(base, sim.policy, state);
    await expect(other.pair(code)).rejects.toThrow(/401/);
  });

  it('wygasły lub błędny kod => 401; po 10 nieudanych próbach => 429 (osobna instancja)', async () => {
    const code = (await alfa.post('/api/devices/pairing-codes')).body.code as string;
    await t.db.owner.query(`UPDATE device_pairing_codes SET expires_at = now() - interval '1 s'`);
    await expect(sim.pair(code)).rejects.toThrow(/401/);
    const other = await createTestApp();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        const r = await other.app.inject({
          method: 'POST',
          url: '/api/device-link/pair',
          payload: {
            code: 'AAAA-AAAA',
            name: 'x',
            platform: 'x',
            publicKey: sim.publicKeyB64,
            protocolVersion: 1,
          },
        });
        statuses.push(r.statusCode);
      }
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(10)).toEqual([429, 429]);
    } finally {
      await other.close();
    }
  });

  it('podpis hello obcym kluczem => rozłączenie 4401; urządzenie odłączone nie połączy się', async () => {
    const code = (await alfa.post('/api/devices/pairing-codes')).body.code as string;
    await sim.pair(code);
    await expect(
      sim.connect({ signWith: generateKeyPairSync('ed25519').privateKey }),
    ).rejects.toThrow(/4401/);
    await sim.connect();
    await alfa.post(`/api/devices/${sim.deviceId}/revoke`);
    await new Promise((r) => setTimeout(r, 50));
    expect(sim.closeCode).toBe(4403);
    await expect(sim.connect()).rejects.toThrow(/4401/);
  });
});

describe('polecenia: odmowa PRZED wysyłką (broker)', () => {
  it('polecenie do urządzenia innej osoby jest odrzucone, Worker nic nie dostaje', async () => {
    const id = await pairAndConnect(alfa);
    await grant(id, 'device.files.read');
    await expect(exec('beta', id, 'device.files.list', { path: fx })).rejects.toMatchObject({
      reason: 'not_owner',
    });
    expect(sim.executed).toHaveLength(0);
    const audit = await t.db.owner.query(
      `SELECT outcome, details FROM audit_log WHERE action = 'device.command' AND actor_user_id = $1`,
      [t.seed.users.beta],
    );
    expect(audit.rows[0]).toMatchObject({ outcome: 'deny' });
  });

  it('zdolność bez grantu i ścieżka poza katalogiem są odrzucane przed wysyłką', async () => {
    const id = await pairAndConnect();
    await grant(id, 'device.files.read');
    await expect(
      exec('alfa', id, 'device.files.write', {
        path: join(fx, 'x.txt'),
        content: 'x',
        baseSha256: null,
      }),
    ).rejects.toMatchObject({
      reason: 'no_device_grant',
    });
    await expect(
      exec('alfa', id, 'device.files.read', { path: join(outside, 'tajne.txt') }),
    ).rejects.toMatchObject({
      reason: 'path_outside_grant',
    });
    await expect(
      exec('alfa', id, 'device.files.read', { path: `${fx}/../poza/tajne.txt` }),
    ).rejects.toBeInstanceOf(DeviceDenied);
    expect(sim.executed).toHaveLength(0);
  });

  it('cofnięcie grantu i odłączenie urządzenia działają przed kolejnym poleceniem', async () => {
    const id = await pairAndConnect();
    const g = await grant(id, 'device.files.read');
    expect(await exec('alfa', id, 'device.files.list', { path: fx })).toMatchObject({
      entries: [{ name: 'notatka.txt' }],
    });
    expect((await alfa.del(`/api/devices/${id}/grants/${g}`)).status).toBe(204);
    await expect(exec('alfa', id, 'device.files.list', { path: fx })).rejects.toMatchObject({
      reason: 'no_device_grant',
    });
    await grant(id, 'device.files.read');
    await alfa.post(`/api/devices/${id}/revoke`);
    await expect(exec('alfa', id, 'device.files.list', { path: fx })).rejects.toMatchObject({
      reason: 'device_revoked',
    });
    expect(sim.executed).toHaveLength(1);
  });
});

describe('polecenia: odmowa po stronie Workera', () => {
  it('symlink wewnątrz katalogu prowadzący na zewnątrz jest odrzucony przez Workera (realpath)', async () => {
    const id = await pairAndConnect();
    await grant(id, 'device.files.read');
    await symlink(join(outside, 'tajne.txt'), join(fx, 'link.txt'));
    await symlink(outside, join(fx, 'katalog-link'));
    await expect(
      exec('alfa', id, 'device.files.read', { path: join(fx, 'link.txt') }),
    ).rejects.toMatchObject({
      reason: 'worker:path_outside_root',
    });
    await expect(
      exec('alfa', id, 'device.files.list', { path: join(fx, 'katalog-link') }),
    ).rejects.toMatchObject({
      reason: 'worker:path_outside_root',
    });
  });

  it('zdolność spoza lokalnej polityki Workera jest odrzucona mimo grantu serwera', async () => {
    sim.policy = { roots: [fx], capabilities: ['device.files.read'] };
    const id = await pairAndConnect();
    await grant(id, 'device.files.write');
    await expect(
      exec('alfa', id, 'device.files.write', {
        path: join(fx, 'nowy.txt'),
        content: 'x',
        baseSha256: null,
      }),
    ).rejects.toMatchObject({ reason: 'worker:capability_not_in_local_policy' });
  });

  it('katalog poza lokalnymi korzeniami Workera jest odrzucony mimo grantu serwera', async () => {
    const id = await pairAndConnect();
    await grant(id, 'device.files.read', outside);
    await expect(
      exec('alfa', id, 'device.files.read', { path: join(outside, 'tajne.txt') }),
    ).rejects.toMatchObject({
      reason: 'worker:no_grant_for_capability',
    });
  });

  it('polecenie z obcym podpisem lub po terminie nie jest wykonywane', async () => {
    const id = await pairAndConnect();
    await grant(id, 'device.files.read');
    const conn = (t.deps.devices.hub as any).conns.get(id);
    const forgedKey = generateKeyPairSync('ed25519').privateKey;
    const payload = JSON.stringify({
      v: 1,
      commandId: '00000000-0000-4000-8000-000000000001',
      deviceId: id,
      taskId: null,
      capability: 'device.files.read',
      params: { path: join(fx, 'notatka.txt') },
      idempotencyKey: 'forged-key-1',
      issuedAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 5000).toISOString(),
    });
    const { signText } = await import('./keys');
    conn.socket.send(
      JSON.stringify({ type: 'command', payload, sig: signText(forgedKey, payload) }),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(sim.rejected).toContain('bad_signature');
    expect(sim.executed).toHaveLength(0);

    await expect(
      t.deps.devices.execute(
        (await loadPrincipal(t.db, t.seed.users.alfa))!,
        'private_agent',
        id,
        'device.files.list',
        { path: fx },
        {
          taskId: null,
          idempotencyKey: 'late-command-1',
          correlationId: 't',
          timeoutMs: -1000,
        },
      ),
    ).rejects.toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(sim.rejected).toContain('expired');
  });
});

describe('zapis pliku: zgoda z diff, kopia, atomowa zamiana, idempotencja', () => {
  it('zapis przez czat wymaga zgody z podglądem diff; po zatwierdzeniu plik zmieniony, kopia zapasowa istnieje', async () => {
    const id = await pairAndConnect();
    await grant(id, 'device.files.read');
    await grant(id, 'device.files.write');
    const target = join(fx, 'notatka.txt');
    const { msgs } = await chat(alfa, `zapisz ${target}: wersja 2`);
    expect(msgs[msgs.length - 1].content).toContain('wymaga Twojej zgody');
    const ap = (await alfa.get('/api/approvals')).body.items[0];
    expect(ap.tool).toBe('device.files.write');
    expect(ap.target).toBe(`Laptop testowy: ${target}`);
    expect(ap.diff).toContain('-wersja 1');
    expect(ap.diff).toContain('+wersja 2');
    expect(ap.action.baseSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(target, 'utf8')).toBe('wersja 1\n');

    expect(
      (await alfa.post(`/api/approvals/${ap.id}/approve`, { actionHash: ap.actionHash })).status,
    ).toBe(200);
    await t.drain();
    expect(await readFile(target, 'utf8')).toBe('wersja 2');
    const backups = await readdir(join(state, 'backups'));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(state, 'backups', backups[0]!), 'utf8')).toBe('wersja 1\n');
    // Brak plików tymczasowych w katalogu użytkownika.
    expect((await readdir(fx)).filter((f) => f.includes('nova-tmp'))).toHaveLength(0);
  });

  it('plik zmieniony po podglądzie => Worker odmawia zapisu (base_changed)', async () => {
    const id = await pairAndConnect();
    await grant(id, 'device.files.read');
    await grant(id, 'device.files.write');
    const target = join(fx, 'notatka.txt');
    await chat(alfa, `zapisz ${target}: nadpisanie`);
    const ap = (await alfa.get('/api/approvals')).body.items[0];
    await writeFile(target, 'ktoś zmienił plik w międzyczasie\n');
    await alfa.post(`/api/approvals/${ap.id}/approve`, { actionHash: ap.actionHash });
    await t.drain();
    expect(await readFile(target, 'utf8')).toBe('ktoś zmienił plik w międzyczasie\n');
    const task = (await alfa.get(`/api/tasks/${ap.taskId}`)).body;
    expect(task.steps.find((s: any) => s.tool === 'device.files.write').error).toContain(
      'base_changed',
    );
  });

  it('ponowienie z tym samym kluczem idempotencji nie zapisuje drugi raz', async () => {
    const id = await pairAndConnect();
    await grant(id, 'device.files.write');
    const target = join(fx, 'nowy.txt');
    await exec(
      'alfa',
      id,
      'device.files.write',
      { path: target, content: 'A', baseSha256: null },
      'idem-key-1',
    );
    await writeFile(target, 'zmiana ręczna');
    await t.db.owner.query(
      `UPDATE device_commands SET status = 'error' WHERE idempotency_key = 'idem-key-1'`,
    );
    const again = await exec(
      'alfa',
      id,
      'device.files.write',
      { path: target, content: 'A', baseSha256: null },
      'idem-key-1',
    );
    expect(again.replay).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('zmiana ręczna');
  });
});

describe('narzędzia urządzeń w rozmowach', () => {
  it('lista plików z czatu prywatnego trafia do rozmowy jako wynik narzędzia', async () => {
    const id = await pairAndConnect();
    await grant(id, 'device.files.read');
    const { msgs } = await chat(alfa, `pliki: ${fx}`);
    const tool = msgs.find((m) => m.role === 'tool');
    expect(tool.content).toContain('notatka.txt');
  });

  it('NovaAI nie ma dostępu do narzędzi urządzeń', async () => {
    const id = await pairAndConnect();
    await grant(id, 'device.files.read');
    const { msgs } = await chat(alfa, `pliki: ${fx}`, 'shared');
    expect(msgs[msgs.length - 1].meta.deniedTools).toEqual([
      { tool: 'device.files.list', reason: 'tool_not_in_context' },
    ]);
    expect(sim.executed).toHaveLength(0);
  });

  it('git status/diff w repozytorium w udostępnionym katalogu', async () => {
    execFileSync('git', ['init', '-q', fx]);
    execFileSync('git', ['-C', fx, 'add', '.']);
    execFileSync('git', [
      '-C',
      fx,
      '-c',
      'user.email=t@example.test',
      '-c',
      'user.name=T',
      'commit',
      '-qm',
      'init',
    ]);
    await writeFile(join(fx, 'notatka.txt'), 'zmienione\n');
    const id = await pairAndConnect();
    await grant(id, 'device.git.read');
    const st = await exec('alfa', id, 'device.git.status', { repoPath: fx });
    expect(String(st.output)).toContain(' M notatka.txt');
    const diff = await exec('alfa', id, 'device.git.diff', { repoPath: fx });
    expect(String(diff.output)).toContain('+zmienione');
  });
});

afterAll(async () => {
  await rm(join(tmpdir(), 'nova-dev-never'), { recursive: true, force: true });
});
