import { expect, test } from '@playwright/test';

/** Przypomnienie wspólne z terminem „teraz”: kolejka dostarcza je obojgu; bez modelu. */
test('wspólne przypomnienie dociera do obojga domowników', async ({ page }) => {
  const text = `Podlać kwiaty (${test.info().project.name}-${Date.now()})`;
  await page.goto('/');
  await page.getByRole('button', { name: /Alfa \(test\)/ }).click();
  await page.goto('/#/home');
  await page.getByLabel('Treść przypomnienia').fill(text);
  // Czas lokalny liczony w przeglądarce (strefa Europe/Warsaw z konfiguracji Playwright).
  const local = await page.evaluate(() => {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  });
  await page.getByLabel('Termin').fill(local);
  await page.getByLabel('Dla kogo').selectOption('shared');
  await page.getByRole('button', { name: 'Dodaj' }).click();
  await expect(page.locator('.notification').filter({ hasText: text })).toBeVisible({
    timeout: 15_000,
  });
  if (process.env.E2E_SCREENSHOTS) {
    await page.screenshot({
      path: `${import.meta.dirname}/../../../docs/screens/${test.info().project.name}-10-home-reminders.png`,
    });
  }

  await page.goto('/#/settings');
  await page.getByRole('button', { name: 'Wyloguj' }).last().click();
  await page.getByRole('button', { name: /Beta \(test\)/ }).click();
  await page.goto('/#/home');
  await expect(page.locator('.notification').filter({ hasText: text })).toBeVisible();
});
