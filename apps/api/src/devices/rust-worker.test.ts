import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../config';
import { loadPrincipal } from '../principal';
import { createTestApp, login, type Client, type TestApp } from '../test/helpers';

/**
 * Interoperacyjność: prawdziwy Worker w Rust (workers/windows) ↔ API w TS.
 * Uruchamiany, gdy istnieje binarka (`cargo build` w workers/windows); w przeciwnym razie pomijany jawnie.
 */
const BIN =
  process.env.NOVA_RUST_WORKER_BIN ??
  resolve(REPO_ROOT, 'workers/windows/target/debug/nova-worker');
const HAS_BIN = existsSync(BIN);

let t: TestApp;
let alfa: Client;
let dir: string;
let fx: string;
let outside: string;
let cfgPath: string;
let worker: ChildProcess | null = null;
let workerExit: Promise<number | null>;
let deviceId: string;

function runBin(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((res) => {
    const p = spawn(BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('exit', (code) => res({ code, out }));
  });
}

const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 5000) => {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};

async function exec(
  capability: any,
  params: Record<string, unknown>,
  key = `rust-${Math.random().toString(36).slice(2)}`,
) {
  const principal = (await loadPrincipal(t.db, t.seed.users.alfa))!;
  return t.deps.devices.execute(principal, 'private_agent', deviceId, capability, params, {
    taskId: null,
    idempotencyKey: key,
    correlationId: 'rust-interop',
    timeoutMs: 5000,
  });
}

describe.skipIf(!HAS_BIN)('Worker Rust ↔ API (interoperacyjność protokołu v1)', () => {
  beforeAll(async () => {
    t = await createTestApp();
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
    alfa = await login(t.app, 'alfa');
    dir = await mkdtemp(join(tmpdir(), 'nova-rust-'));
    fx = join(dir, 'projekt');
    outside = join(dir, 'poza');
    await mkdir(fx);
    await mkdir(outside);
    await writeFile(join(fx, 'notatka.txt'), 'wersja 1\n');
    await writeFile(join(outside, 'tajne.txt'), 'SEKRET');
    cfgPath = join(dir, 'worker.toml');
    await writeFile(
      cfgPath,
      [
        `server = "${base}"`,
        `name = "Worker Rust (test)"`,
        `state_dir = '${join(dir, 'state')}'`,
        `[[roots]]`,
        `path = '${fx}'`,
        `capabilities = ["device.files.read", "device.files.write", "device.git.read"]`,
      ].join('\n'),
    );
    const code = (await alfa.post('/api/devices/pairing-codes')).body.code as string;
    const paired = await runBin(['pair', '--config', cfgPath, '--code', code]);
    expect(paired.code, paired.out).toBe(0);
    deviceId = (await alfa.get('/api/devices')).body.items[0].id;
    worker = spawn(BIN, ['run', '--config', cfgPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    workerExit = new Promise((res) => worker!.on('exit', (c) => res(c)));
    await waitFor(() => t.deps.devices.hub.isOnline(deviceId));
  }, 30_000);

  afterAll(async () => {
    worker?.kill();
    await t?.close();
  });

  it('sparowane urządzenie jest online i widoczne tylko dla właściciela', async () => {
    const d = (await alfa.get('/api/devices')).body.items[0];
    expect(d).toMatchObject({ name: 'Worker Rust (test)', online: true, status: 'active' });
  });

  it('lista i odczyt pliku po grancie (podpisy w obie strony)', async () => {
    await alfa.post(`/api/devices/${deviceId}/grants`, {
      capability: 'device.files.read',
      root: fx,
    });
    await new Promise((r) => setTimeout(r, 200)); // podpisane granty docierają do Workera
    const list = await exec('device.files.list', { path: fx });
    expect((list.entries as Array<{ name: string }>).map((e) => e.name)).toContain('notatka.txt');
    const read = await exec('device.files.read', { path: join(fx, 'notatka.txt') });
    expect(read.content).toBe('wersja 1\n');
    expect(read.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('symlink prowadzący poza katalog jest odrzucony przez Worker Rust', async () => {
    await symlink(join(outside, 'tajne.txt'), join(fx, 'link.txt'));
    await expect(exec('device.files.read', { path: join(fx, 'link.txt') })).rejects.toMatchObject({
      reason: 'worker:path_outside_root',
    });
  });

  it('zapis z baseSha256: kopia zapasowa w katalogu stanu i atomowa zamiana', async () => {
    await alfa.post(`/api/devices/${deviceId}/grants`, {
      capability: 'device.files.write',
      root: fx,
    });
    await new Promise((r) => setTimeout(r, 200));
    const read = await exec('device.files.read', { path: join(fx, 'notatka.txt') });
    const w = await exec('device.files.write', {
      path: join(fx, 'notatka.txt'),
      content: 'wersja 2\n',
      baseSha256: read.sha256,
    });
    expect(await readFile(join(fx, 'notatka.txt'), 'utf8')).toBe('wersja 2\n');
    expect(String(w.backupPath)).toContain(join(dir, 'state', 'backups'));
    expect((await readdir(fx)).some((f) => f.includes('nova-tmp'))).toBe(false);
    await expect(
      exec('device.files.write', {
        path: join(fx, 'notatka.txt'),
        content: 'x',
        baseSha256: read.sha256,
      }),
    ).rejects.toMatchObject({ reason: 'worker:base_changed' });
  });

  it('odłączenie urządzenia kończy proces Workera (bez ponownego łączenia)', async () => {
    await alfa.post(`/api/devices/${deviceId}/revoke`);
    const code = await Promise.race([
      workerExit,
      new Promise((r) => setTimeout(() => r('timeout'), 5000)),
    ]);
    expect(code).not.toBe('timeout');
    expect(code).not.toBe(0);
    expect(t.deps.devices.hub.isOnline(deviceId)).toBe(false);
  });
});
