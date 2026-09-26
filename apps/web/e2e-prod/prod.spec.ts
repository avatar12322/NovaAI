import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { makePdf } from '../../api/src/test/pdf-fixture';
import { PROD_BASE, PROD_ENV } from '../playwright.prod.config';

const REPO = resolve(import.meta.dirname, '../../..');

function admin(...args: string[]): string {
  return execFileSync('node', ['apps/api/dist/cli.js', ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ...PROD_ENV },
  });
}

async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

test('produkcja: CSP bez naruszeń, brak logowania testowego, konto z CLI, czat na żywo', async ({
  page,
  request,
}) => {
  const problems: string[] = [];
  const failed = new Set<string>();
  page.on('console', (m) => {
    // Błędy HTTP są sprawdzane niżej po adresach (część jest oczekiwana, np. 401 przed zalogowaniem).
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource'))
      problems.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) failed.add(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) =>
      console.error(`CSP: ${e.violatedDirective} ${e.blockedURI}`),
    );
  });

  // Nagłówki: CSP i bufor dla frontendu, no-store dla API; logowanie testowe niedostępne.
  const index = await request.get('/');
  expect(index.headers()['content-security-policy']).toContain("script-src 'self'");
  expect(index.headers()['cache-control']).toBe('no-cache');
  expect((await request.get('/api/health')).headers()['cache-control']).toBe('no-store');
  expect((await request.get('/api/auth/dev-users')).status()).toBe(404);
  // Pliki spoza dist i ukryte nie są serwowane (także przez zakodowane `..`).
  for (const path of ['/.env', '/%2e%2e/%2e%2e/%2e%2e/.env', '/..%2f..%2f..%2f.env']) {
    const r = await request.get(path);
    expect([403, 404]).toContain(r.status());
    expect(await r.text()).not.toContain('DATABASE_URL');
  }

  await virtualAuthenticator(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Zaloguj kluczem dostępu' })).toBeVisible();
  await expect(page.getByText('Poproś administratora')).toBeVisible();

  const email = `prod-${Date.now()}@example.test`;
  admin('create-household', 'Dom produkcyjny (test)', `${email}:Osoba Prod`);
  const link = admin('enroll', email).trim().split('\n').pop()!;
  expect(link.startsWith(`${PROD_BASE}/#/enroll/`)).toBe(true);
  await page.goto(link);
  await page.getByRole('button', { name: 'Utwórz klucz dostępu' }).click();
  await expect(page.getByRole('navigation', { name: 'Nawigacja główna' })).toContainText(
    'Osoba Prod',
  );

  // Czat przez kolejkę + SSE (tryb demo bez konfiguracji modeli).
  await page.getByRole('button', { name: 'Nowa' }).click();
  const input = page.getByLabel('Wiadomość');
  await input.fill('zapamiętaj: test produkcyjny');
  await input.press('Enter');
  await expect(page.locator('.msg-assistant').filter({ hasText: 'Proponuję zapisać' })).toBeVisible(
    { timeout: 15_000 },
  );

  // Dokument PDF: odczyt w wątku z bundla (dist/pdf-worker.mjs), odpowiedź ze źródłem.
  await page.goto('/#/documents');
  await page.setInputFiles('#doc-file', {
    name: 'Umowa.pdf',
    mimeType: 'application/pdf',
    buffer: makePdf([['Umowa najmu'], ['Kaucja wynosi 3000 zl.']]),
  });
  await expect(page.locator('.document .badge').filter({ hasText: 'gotowy' })).toBeVisible({
    timeout: 15_000,
  });
  await page.goto('/#/chat/private');
  await page.getByRole('button', { name: 'Nowa' }).click();
  await expect(page.getByText('Napisz pierwszą wiadomość')).toBeVisible();
  await page.getByLabel('Wiadomość').fill('Ile wynosi kaucja?');
  await page.getByLabel('Wiadomość').press('Enter');
  await expect(page.getByRole('link', { name: 'D1 Umowa · s. 2' })).toBeVisible({
    timeout: 15_000,
  });

  // Ciasteczko sesji: HttpOnly, Secure, SameSite=Strict.
  const cookie = (await page.context().cookies()).find((c) => c.name === 'nova_sid');
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict' });

  // Wylogowanie i ponowne logowanie samym kluczem.
  await page.goto('/#/settings');
  await page.getByRole('button', { name: 'Wyloguj' }).last().click();
  await page.getByRole('button', { name: 'Zaloguj kluczem dostępu' }).click();
  await expect(page.getByRole('navigation', { name: 'Nawigacja główna' })).toContainText(
    'Osoba Prod',
  );

  expect(problems).toEqual([]);
  // Jedyne oczekiwane błędy: brak sesji przed zalogowaniem i wyłączone logowanie testowe.
  expect([...failed].sort()).toEqual(['401 /api/me', '404 /api/auth/dev-users']);
});
