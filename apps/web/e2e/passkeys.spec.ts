import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Passkeys z wirtualnym uwierzytelniaczem Chromium (CDP WebAuthn). Origin musi być domeną: http://localhost:5174.
 */
const BASE = 'http://localhost:5174';
const REPO = resolve(import.meta.dirname, '../../..');

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

function admin(...args: string[]): string {
  const db = (role: string, pass: string) => `postgres://${role}:${pass}@127.0.0.1:54329/nova_e2e`;
  return execFileSync('pnpm', ['--silent', '--filter', '@nova/api', 'admin', ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: {
      ...process.env,
      NOVA_ENV: 'test',
      DATABASE_URL_APP: db('nova_app', 'nova_app_dev'),
      DATABASE_URL_OWNER: db('nova_owner', 'nova_owner_dev'),
      NOVA_WEB_ORIGIN: BASE,
      NOVA_PUBLIC_URL: BASE,
    },
  });
}

test('rejestracja klucza w Ustawieniach i logowanie bez hasła', async ({ page }) => {
  await virtualAuthenticator(page);
  await page.goto(`${BASE}/`);
  await page.getByRole('button', { name: /Alfa \(test\)/ }).click();
  await page.goto(`${BASE}/#/settings`);
  await page.getByRole('button', { name: 'Dodaj klucz dostępu' }).click();
  await expect(page.locator('.passkeys li')).toHaveCount(1);
  await page.getByRole('button', { name: 'Wyloguj' }).last().click();
  await page.getByRole('button', { name: 'Zaloguj kluczem dostępu' }).click();
  await expect(page.locator('.envbar')).toContainText('Alfa (test)');
  await page.goto(`${BASE}/#/settings`);
  await expect(page.getByText('klucz dostępu (passkey)')).toBeVisible();
});

test('jednorazowy link rejestracyjny z CLI tworzy konto z kluczem', async ({ page }) => {
  await virtualAuthenticator(page);
  const email = `osoba-${test.info().project.name}-${Date.now()}@example.test`;
  admin('create-household', `Dom ${test.info().project.name}`, `${email}:Osoba E2E`);
  const out = admin('enroll', email);
  const link = out.trim().split('\n').pop()!;
  expect(link).toContain(`${BASE}/#/enroll/`);
  await page.goto(link);
  await page.getByRole('button', { name: 'Utwórz klucz dostępu' }).click();
  await expect(page.locator('.envbar')).toContainText('Osoba E2E');
  // Link nie działa drugi raz.
  await page.goto(link);
  await page.getByRole('button', { name: 'Utwórz klucz dostępu' }).click();
  await expect(page.getByRole('alert')).toContainText('nieprawidłowy lub wygasł');
});
