import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDev } from '../db/seed';
import {
  clientFor,
  createTestApp,
  login,
  truncateAll,
  type Client,
  type TestApp,
} from '../test/helpers';
import { SoftAuthenticator } from '../test/soft-authenticator';

/** Domownicy: konta tylko z zaproszenia właściciela, rejestracja klucza z linku, nowy link, usunięcie. */
let t: TestApp;
let alfa: Client;
let beta: Client;
const ORIGIN = 'http://localhost:5173';

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());
beforeEach(async () => {
  await truncateAll(t.db);
  t.seed = await seedDev(t.db, 'test');
  alfa = await login(t.app, 'alfa');
  beta = await login(t.app, 'beta');
});

const anon = () => clientFor(t.app, '');
const tokenOf = (link: string) => link.split('/').pop()!;

/** Rejestracja klucza z linku zaproszenia — zwraca klienta z sesją nowej osoby. */
async function enroll(link: string, auth: SoftAuthenticator): Promise<Client> {
  const token = tokenOf(link);
  const o = await anon().post('/api/auth/enroll/options', { token });
  expect(o.status).toBe(200);
  const v = await t.app.inject({
    method: 'POST',
    url: '/api/auth/enroll/verify',
    headers: { 'x-nova-csrf': '1' },
    payload: { token, challengeId: o.body.challengeId, response: auth.create(o.body.options) },
  });
  expect(v.statusCode).toBe(201);
  return clientFor(t.app, String(v.headers['set-cookie']).split(';')[0]!);
}

describe('domownicy i zaproszenia', () => {
  it('zaproszenie: link na 7 dni, rejestracja klucza, osoba w domu z własnym asystentem', async () => {
    const list = (await alfa.get('/api/household/members')).body;
    expect(list.canManage).toBe(true);
    expect(list.members.map((m: any) => [m.displayName, m.role, m.status])).toEqual([
      ['Alfa (test)', 'owner', 'active'],
      ['Beta (test)', 'member', 'active'],
    ]);

    const inv = await alfa.post('/api/household/invites', {
      email: 'Celina@Example.test',
      displayName: 'Celina',
    });
    expect(inv.status).toBe(201);
    expect(inv.body.link).toMatch(/^http:\/\/localhost:5173\/#\/enroll\/[A-Za-z0-9_-]{40,}$/);
    const days = (Date.parse(inv.body.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
    const invited = (await alfa.get('/api/household/members')).body.members.at(-1);
    expect(invited).toMatchObject({
      displayName: 'Celina',
      email: 'celina@example.test',
      status: 'invited',
    });
    expect(invited.inviteExpiresAt).not.toBeNull();

    const celina = await enroll(
      inv.body.link,
      new SoftAuthenticator({ origin: ORIGIN, rpId: 'localhost' }),
    );
    const me = (await celina.get('/api/me')).body;
    expect(me.user.displayName).toBe('Celina');
    expect(me.household.id).toBe(t.seed.householdId);
    expect(me.agents.map((a: { name: string }) => a.name).sort()).toEqual([
      'Asystent: Celina',
      'NovaAI',
    ]);
    const after = (await alfa.get('/api/household/members')).body.members.at(-1);
    expect(after).toMatchObject({ status: 'active', inviteExpiresAt: null });

    // Domownik widzi listę bez cudzych adresów e-mail i niczego nie zmienia.
    const seen = (await beta.get('/api/household/members')).body;
    expect(seen.canManage).toBe(false);
    expect(seen.members.find((m: any) => m.displayName === 'Celina').email).toBeNull();
    expect(seen.members.find((m: any) => m.me).email).toBe('beta@example.test');
    expect(
      (await beta.post('/api/household/invites', { email: 'x@example.test', displayName: 'X' }))
        .status,
    ).toBe(403);
    expect((await beta.post(`/api/household/members/${after.id}/link`)).status).toBe(403);
    expect((await beta.del(`/api/household/members/${after.id}`)).status).toBe(403);

    const audit = await t.db.owner.query(
      `SELECT action, details::text AS d FROM audit_log WHERE action LIKE 'household.%'`,
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['household.invite']);
    expect(audit.rows[0].d).not.toContain('celina');
  });

  it('błędy zaproszenia: zajęty adres, zły adres, pełny dom', async () => {
    expect(
      (await alfa.post('/api/household/invites', { email: 'beta@example.test', displayName: 'B' }))
        .status,
    ).toBe(409);
    expect(
      (await alfa.post('/api/household/invites', { email: 'nie-email', displayName: 'X' })).status,
    ).toBe(400);
    for (let i = 0; i < 6; i++)
      expect(
        (
          await alfa.post('/api/household/invites', {
            email: `o${i}@example.test`,
            displayName: `O${i}`,
          })
        ).status,
      ).toBe(201);
    const full = await alfa.post('/api/household/invites', {
      email: 'o9@example.test',
      displayName: 'O9',
    });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('household_full');
  });

  it('nowy link unieważnia poprzedni; usunięcie wyłącza konto i sesje; ponowne zaproszenie przywraca', async () => {
    const inv = await alfa.post('/api/household/invites', {
      email: 'dawid@example.test',
      displayName: 'Dawid',
    });
    const again = await alfa.post(`/api/household/members/${inv.body.memberId}/link`);
    expect(again.status).toBe(200);
    expect(
      (await anon().post('/api/auth/enroll/options', { token: tokenOf(inv.body.link) })).status,
    ).toBe(401);
    const dawid = await enroll(
      again.body.link,
      new SoftAuthenticator({ origin: ORIGIN, rpId: 'localhost' }),
    );
    expect((await dawid.get('/api/me')).status).toBe(200);

    expect((await alfa.del(`/api/household/members/${t.seed.users.alfa}`)).status).toBe(409);
    expect((await alfa.del(`/api/household/members/${inv.body.memberId}`)).status).toBe(204);
    expect((await dawid.get('/api/me')).status).toBe(401);
    const names = (await alfa.get('/api/household/members')).body.members.map(
      (m: any) => m.displayName,
    );
    expect(names).not.toContain('Dawid');

    // Ta sama osoba zaproszona ponownie: konto przywrócone, nowy link działa.
    const back = await alfa.post('/api/household/invites', {
      email: 'dawid@example.test',
      displayName: 'Dawid',
    });
    expect(back.status).toBe(201);
    expect(back.body.memberId).toBe(inv.body.memberId);
    const dawid2 = await enroll(
      back.body.link,
      new SoftAuthenticator({ origin: ORIGIN, rpId: 'localhost' }),
    );
    expect((await dawid2.get('/api/me')).body.household.id).toBe(t.seed.householdId);
  });
});
