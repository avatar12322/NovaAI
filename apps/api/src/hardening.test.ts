import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupExpired } from './maintenance';
import { createTestApp, type TestApp } from './test/helpers';

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const loginOptions = (app: TestApp['app'], ip: string) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/passkeys/login/options',
    headers: { 'x-nova-csrf': '1', 'x-forwarded-for': ip },
    remoteAddress: '10.0.0.1',
    payload: {},
  });

describe('limity tras bez sesji', () => {
  it('po 30 żądaniach na minutę z jednego adresu => 429', async () => {
    t = await createTestApp();
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++)
      statuses.push((await loginOptions(t.app, '203.0.113.5')).statusCode);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
  });

  it('bez NOVA_TRUST_PROXY nagłówek X-Forwarded-For nie omija limitu', async () => {
    t = await createTestApp();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++)
      statuses.push((await loginOptions(t.app, `203.0.113.${i}`)).statusCode);
    expect(statuses[30]).toBe(429);
  });

  it('z NOVA_TRUST_PROXY=1 limit liczony per adres klienta (za proxy)', async () => {
    t = await createTestApp({ NOVA_TRUST_PROXY: '1' });
    for (let i = 0; i < 30; i++) await loginOptions(t.app, '203.0.113.7');
    expect((await loginOptions(t.app, '203.0.113.7')).statusCode).toBe(429);
    expect((await loginOptions(t.app, '203.0.113.8')).statusCode).toBe(200);
  });
});

describe('sprzątanie wygasłych artefaktów', () => {
  it('usuwa tylko przeterminowane rekordy', async () => {
    t = await createTestApp();
    const { owner } = t.db;
    const alfa = t.seed.users.alfa;
    const hash = () => createHash('sha256').update(randomBytes(16)).digest();
    const insertSession = (expires: string) =>
      owner.query(
        `INSERT INTO auth_sessions (user_id, token_hash, method, env, expires_at)
         VALUES ($1, $2, 'dev', 'test', now() + $3::interval)`,
        [alfa, hash(), expires],
      );
    await insertSession('-40 days');
    await insertSession('1 day');
    const before = await cleanupExpired(t.db);
    expect(before.sessions).toBe(1);
    const left = await owner.query('SELECT count(*)::int AS n FROM auth_sessions');
    expect(left.rows[0].n).toBe(1);
    const again = await cleanupExpired(t.db);
    expect(Object.values(again).every((n) => n === 0)).toBe(true);
  });
});
