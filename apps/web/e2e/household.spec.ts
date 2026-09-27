import { expect, test, type Page } from '@playwright/test';
import { shot } from './helpers';

/**
 * Domownicy: właściciel zaprasza w Ustawieniach, osoba otwiera link na „swoim urządzeniu” (osobny kontekst
 * przeglądarki z wirtualnym uwierzytelniaczem) i tworzy klucz dostępu; usunięcie z domu wylogowuje ją.
 * Origin musi być domeną (WebAuthn): http://localhost:5174.
 */
const BASE = 'http://localhost:5174';

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

test('zaproszenie domownika: link, klucz dostępu na drugim urządzeniu, usunięcie z domu', async ({
  page,
  browser,
}) => {
  const who = `Celina ${test.info().project.name}`;
  const email = `celina-${test.info().project.name}-${Date.now()}@example.test`;

  await page.goto(`${BASE}/`);
  await page.getByRole('button', { name: /Alfa \(test\)/ }).click();
  await page.goto(`${BASE}/#/settings`);
  const form = page.getByRole('form', { name: 'Zaproś domownika' });
  await form.getByPlaceholder('Imię').fill(who);
  await form.getByPlaceholder('E-mail').fill(email);
  await form.getByRole('button', { name: 'Zaproś' }).click();
  const link = await page.getByLabel('Link zaproszenia').inputValue();
  expect(link).toContain(`${BASE}/#/enroll/`);
  const row = page.getByRole('list', { name: 'Osoby w domu' }).getByRole('listitem').filter({
    hasText: who,
  });
  await expect(row).toContainText('zaproszony — link ważny do');
  await page.getByRole('heading', { name: 'Domownicy' }).scrollIntoViewIfNeeded();
  await shot(page, '40-household-invite');

  // Drugie urządzenie: osobny kontekst (bez sesji Alfy).
  const other = await browser.newContext();
  const phone = await other.newPage();
  await virtualAuthenticator(phone);
  await phone.goto(link);
  await phone.getByRole('button', { name: 'Utwórz klucz dostępu' }).click();
  await expect(phone.locator('.envbar')).toContainText(who);

  await page.reload();
  await expect(row).toContainText('domownik');
  await expect(row).not.toContainText('zaproszony');

  page.once('dialog', (d) => void d.accept());
  await row.getByRole('button', { name: 'Usuń z domu' }).click();
  await expect(row).toHaveCount(0);
  await phone.reload();
  await expect(phone.getByRole('button', { name: 'Zaloguj kluczem dostępu' })).toBeVisible();
  await other.close();
});
