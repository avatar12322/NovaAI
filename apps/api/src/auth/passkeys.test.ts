import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEnrollmentLink, createHousehold } from '../db/admin';
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

/** Passkeys: rejestracja, logowanie, powtórki, origin, UV, licznik, jednorazowe linki rejestracyjne. */
let t: TestApp;
let alfa: Client;
const ORIGIN = 'http://localhost:5173';

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());
beforeEach(async () => {
  await truncateAll(t.db);
  t.seed = await seedDev(t.db, 'test');
  alfa = await login(t.app, 'alfa');
});

const anon = () => clientFor(t.app, '');

async function register(c: Client, auth: SoftAuthenticator) {
  const o = await c.post('/api/auth/passkeys/register/options');
  expect(o.status).toBe(200);
  expect(o.body.options).toMatchObject({
    rp: { id: 'localhost' },
    authenticatorSelection: { userVerification: 'required' },
  });
  return c.post('/api/auth/passkeys/register/verify', {
    challengeId: o.body.challengeId,
    response: auth.create(o.body.options),
  });
}

async function passkeyLogin(
  auth: SoftAuthenticator,
  o: Parameters<SoftAuthenticator['get']>[1] = {},
) {
  const opts = await anon().post('/api/auth/passkeys/login/options');
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/auth/passkeys/login/verify',
    headers: { 'x-nova-csrf': '1' },
    payload: { challengeId: opts.body.challengeId, response: auth.get(opts.body.options, o) },
  });
  return { res, opts };
}

describe('passkeys', () => {
  it('rejestracja przez zalogowanego użytkownika i logowanie bez hasła (sesja passkey)', async () => {
    const auth = new SoftAuthenticator({ origin: ORIGIN, rpId: 'localhost' });
    expect((await register(alfa, auth)).status).toBe(201);
    expect((await alfa.get('/api/auth/passkeys')).body.items).toHaveLength(1);
    const { res } = await passkeyLogin(auth);
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers['set-cookie']).split(';')[0]!;
    const me = await clientFor(t.app, cookie).get('/api/me');
    expect(me.body).toMatchObject({
      user: { id: t.seed.users.alfa },
      session: { method: 'passkey' },
    });
  });

  it('powtórka odpowiedzi i ponowne użycie wyzwania są odrzucane', async () => {
    const auth = new SoftAuthenticator({ origin: ORIGIN, rpId: 'localhost' });
    await register(alfa, auth);
    const { res, opts } = await passkeyLogin(auth);
    expect(res.statusCode).toBe(200);
    const replay = await t.app.inject({
      method: 'POST',
      url: '/api/auth/passkeys/login/verify',
      headers: { 'x-nova-csrf': '1' },
      payload: { challengeId: opts.body.challengeId, response: auth.get(opts.body.options) },
    });
    expect(replay.json().error.code).toBe('challenge_invalid');
    // Nowe wyzwanie, ale odpowiedź podpisana dla starego => odmowa.
    const fresh = await anon().post('/api/auth/passkeys/login/options');
    const stale = await t.app.inject({
      method: 'POST',
      url: '/api/auth/passkeys/login/verify',
      headers: { 'x-nova-csrf': '1' },
      payload: { challengeId: fresh.body.challengeId, response: auth.get(opts.body.options) },
    });
    expect(stale.statusCode).toBe(401);
  });

  it('obcy origin, brak weryfikacji użytkownika (UV) i cofnięty licznik są odrzucane', async () => {
    const auth = new SoftAuthenticator({ origin: ORIGIN, rpId: 'localhost' });
    const o = await alfa.post('/api/auth/passkeys/register/options');
    const bad = await alfa.post('/api/auth/passkeys/register/verify', {
      challengeId: o.body.challengeId,
      response: auth.create(o.body.options, { origin: 'https://evil.example' }),
    });
    expect(bad.status).toBe(400);
    expect((await register(alfa, auth)).status).toBe(201);
    expect((await passkeyLogin(auth, { origin: 'https://evil.example' })).res.statusCode).toBe(401);
    expect((await passkeyLogin(auth, { userVerified: false })).res.statusCode).toBe(401);
    expect((await passkeyLogin(auth, { counter: 10 })).res.statusCode).toBe(200);
    expect((await passkeyLogin(auth, { counter: 5 })).res.statusCode).toBe(401);
    const audit = await t.db.owner.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.passkey_login' AND outcome = 'deny'`,
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(3);
  });

  it('nieznany klucz => 401; nie można usunąć cudzego klucza', async () => {
    const stranger = new SoftAuthenticator({ origin: ORIGIN, rpId: 'localhost' });
    expect((await passkeyLogin(stranger)).res.statusCode).toBe(401);
    const auth = new SoftAuthenticator({ origin: ORIGIN, rpId: 'localhost' });
    await register(alfa, auth);
    const id = (await alfa.get('/api/auth/passkeys')).body.items[0].id;
    const beta = await login(t.app, 'beta');
    expect((await beta.del(`/api/auth/passkeys/${id}`)).status).toBe(404);
    expect((await alfa.del(`/api/auth/passkeys/${id}`)).status).toBe(204);
  });
});

describe('bootstrap produkcyjny: dom z CLI i jednorazowy link rejestracji', () => {
  it('link działa raz, tworzy sesję nowej osoby, nie działa po wygaśnięciu', async () => {
    await createHousehold(t.db, 'Dom produkcyjny', [
      { email: 'osoba1@example.test', displayName: 'Osoba 1' },
      { email: 'osoba2@example.test', displayName: 'Osoba 2' },
    ]);
    const link = await createEnrollmentLink(t.db, t.config, 'osoba1@example.test');
    expect(link).toMatch(/^http:\/\/localhost:5173\/#\/enroll\/[A-Za-z0-9_-]{40,}$/);
    const token = link.split('/').pop()!;
    const auth = new SoftAuthenticator({ origin: ORIGIN, rpId: 'localhost' });
    const o = await anon().post('/api/auth/enroll/options', { token });
    expect(o.status).toBe(200);
    const v = await t.app.inject({
      method: 'POST',
      url: '/api/auth/enroll/verify',
      headers: { 'x-nova-csrf': '1' },
      payload: { token, challengeId: o.body.challengeId, response: auth.create(o.body.options) },
    });
    expect(v.statusCode).toBe(201);
    const me = await clientFor(t.app, String(v.headers['set-cookie']).split(';')[0]!).get(
      '/api/me',
    );
    expect(me.body.user.displayName).toBe('Osoba 1');
    expect(me.body.household.name).toBe('Dom produkcyjny');
    expect(me.body.agents.map((a: { name: string }) => a.name).sort()).toEqual([
      'Asystent: Osoba 1',
      'NovaAI',
    ]);
    // Drugi raz ten sam link — odmowa.
    expect((await anon().post('/api/auth/enroll/options', { token })).status).toBe(401);
    // Wygasły link.
    const link2 = await createEnrollmentLink(t.db, t.config, 'osoba2@example.test');
    await t.db.owner.query(
      `UPDATE enrollment_tokens SET expires_at = now() - interval '1 s' WHERE used_at IS NULL`,
    );
    expect(
      (await anon().post('/api/auth/enroll/options', { token: link2.split('/').pop() })).status,
    ).toBe(401);
    // Zalogowanie passkey nowej osoby działa.
    expect((await passkeyLogin(auth)).res.statusCode).toBe(200);
  });

  it('konfiguracja logowania: w produkcji bez trybu testowego, passkeys dostępne', async () => {
    const { parseConfig } = await import('../config');
    const { TEST_ENV } = await import('../test/env');
    const cfg = parseConfig({
      ...TEST_ENV,
      NOVA_ENV: 'production',
      NOVA_DEV_LOGIN: 'false',
      NOVA_WEB_ORIGIN: 'https://nova.example.com',
    });
    expect(cfg.webauthn).toEqual({
      rpId: 'nova.example.com',
      rpName: 'NovaAI',
      origins: ['https://nova.example.com'],
    });
    expect((await anon().get('/api/auth/config')).body).toEqual({
      devLogin: true,
      passkeys: true,
      rpId: 'localhost',
    });
  });
});
