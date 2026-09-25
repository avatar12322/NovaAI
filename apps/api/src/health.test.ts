import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from './config';
import { createTestApp, type TestApp } from './test/helpers';
import { TEST_ENV } from './test/env';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

describe('M0: healthcheck i konfiguracja', () => {
  it('GET /api/health odpowiada ok z bazą i migracjami', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ status: 'ok', db: 'ok', env: 'test', devLogin: true });
    expect(body.migrations.pending).toBe(0);
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('przekazuje poprawny x-request-id i odrzuca podejrzany', async () => {
    const ok = await t.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-request-id': 'req-12345678' },
    });
    expect(ok.headers['x-request-id']).toBe('req-12345678');
    const bad = await t.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-request-id': '<script>' },
    });
    expect(bad.headers['x-request-id']).not.toBe('<script>');
  });

  it('nieznana trasa => 404 w formacie błędu API', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('logowanie testowe jest zabronione w produkcji (twardy błąd startu)', () => {
    expect(() =>
      parseConfig({ ...TEST_ENV, NOVA_ENV: 'production', NOVA_DEV_LOGIN: 'true' }),
    ).toThrow(ConfigError);
  });

  it('w produkcji bez NOVA_DEV_LOGIN trasa dev-login nie istnieje', async () => {
    const cfg = parseConfig({ ...TEST_ENV, NOVA_ENV: 'production', NOVA_DEV_LOGIN: 'false' });
    expect(cfg.devLogin).toBe(false);
    const { buildServer } = await import('./server');
    const app = await buildServer({ ...t.deps, config: cfg });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/dev-login',
      headers: { 'x-nova-csrf': '1' },
      payload: { user: 'alfa' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
