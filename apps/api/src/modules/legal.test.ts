import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../test/helpers';

/** Strony prawne dla ekranu zgody Google: publiczne, z kontaktem z konfiguracji, z oświadczeniem Limited Use. */
describe('polityka prywatności i warunki', () => {
  let t: TestApp;
  afterAll(async () => t?.close());

  it('publiczne strony z kontaktem, zakresami Google i Limited Use', async () => {
    t = await createTestApp({
      NOVA_CONTACT_EMAIL: 'kontakt@example.test',
      NOVA_PUBLIC_URL: 'https://nova.example.test',
    });
    const p = await t.app.inject({ method: 'GET', url: '/privacy' });
    expect(p.statusCode).toBe(200);
    expect(p.headers['content-type']).toContain('text/html');
    expect(p.headers['content-security-policy']).toContain("script-src 'self'");
    expect(p.body).toContain('mailto:kontakt@example.test');
    expect(p.body).toContain('https://nova.example.test');
    for (const scope of ['gmail.readonly', 'gmail.send', 'calendar.freebusy'])
      expect(p.body).toContain(scope);
    expect(p.body).toContain('including the Limited Use requirements');
    expect(p.body).not.toContain('<script');

    const terms = await t.app.inject({ method: 'GET', url: '/terms' });
    expect(terms.statusCode).toBe(200);
    expect(terms.body).toContain('href="/privacy"');
    expect(terms.body).toContain('kontakt@example.test');
  });
});
