import { devices, expect, test } from '@playwright/test';
import { loginAs } from './helpers';

/**
 * Powiadomienia push w Ustawieniach. Sama subskrypcja wymaga zbudowanej aplikacji z service workerem
 * i prawdziwej usługi push (poza zasięgiem testów) — tu: stany panelu i komunikaty.
 */
test('panel powiadomień: przycisk włączenia i czytelny komunikat bez service workera', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['notifications']);
  await loginAs(page, 'Beta (test)');
  await page.goto('/#/settings');
  const panel = page.getByRole('region', { name: 'Powiadomienia' });
  await expect(panel).toContainText('Przypomnienia, wiadomości od domowników');
  await panel.getByRole('button', { name: 'Włącz powiadomienia na tym urządzeniu' }).click();
  // Serwer deweloperski (Vite) nie rejestruje service workera — komunikat zamiast cichego błędu.
  await expect(panel.getByRole('alert')).toContainText('zainstalowanej aplikacji');
});

test('iPhone w Safari (bez ekranu głównego): instrukcja dodania aplikacji', async ({ browser }) => {
  const ctx = await browser.newContext({
    ...devices['iPhone 13'],
    baseURL: test.info().project.use.baseURL,
  });
  const page = await ctx.newPage();
  await loginAs(page, 'Alfa (test)');
  await page.goto('/#/settings');
  await expect(page.getByText('Do ekranu początkowego')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Włącz powiadomienia na tym urządzeniu' }),
  ).toHaveCount(0);
  await ctx.close();
});

test('przegląd dnia: godziny, podgląd „jutro”, miasto pogody tylko u właściciela', async ({
  page,
}) => {
  await loginAs(page, 'Beta (test)');
  await page.goto('/#/settings');
  const digest = page.getByRole('group', { name: 'Przegląd dnia' });
  await expect(digest.getByLabel('Godzina porannego przeglądu')).toHaveValue('07:00');
  await expect(digest.getByLabel('Godzina wieczornego przeglądu')).toHaveValue('22:00');
  await digest.getByRole('button', { name: 'Podgląd' }).last().click();
  await expect(digest.getByRole('status', { name: 'Podgląd przeglądu' })).toContainText('Jutro:');
  await digest.getByRole('checkbox', { name: 'Wieczorem — co jutro' }).uncheck();
  await expect(digest.getByLabel('Godzina wieczornego przeglądu')).toBeDisabled();
  await page.reload();
  await expect(
    page.getByRole('group', { name: 'Przegląd dnia' }).getByRole('checkbox', {
      name: 'Wieczorem — co jutro',
    }),
  ).not.toBeChecked();
  await expect(page.getByRole('form', { name: 'Miasto prognozy pogody' })).toHaveCount(0);
  // Przywrócenie ustawienia (baza e2e wspólna dla projektów).
  await page
    .getByRole('group', { name: 'Przegląd dnia' })
    .getByRole('checkbox', { name: 'Wieczorem — co jutro' })
    .check();
});
