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
  // Etykiety dokładnie — na ekranie Dom jest też panel „Terminy” (pole „Data terminu”, „Dodaj termin”).
  await page.getByLabel('Termin', { exact: true }).fill(local);
  await page.getByLabel('Dla kogo').selectOption('shared');
  await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
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
  const item = page.locator('.notification').filter({ hasText: text });
  await expect(item).toBeVisible();

  // „Oznacz jako przeczytane”: liczniki (przegląd dnia, menu „Dom”) maleją od razu, bez ponownego otwierania.
  const unread = page
    .locator('.briefing-item')
    .filter({ hasText: 'Nieprzeczytane' })
    .locator('.briefing-count');
  const domBadge = page
    .locator('a:visible')
    .filter({ has: page.getByText('Dom', { exact: true }) })
    .locator('.count');
  await expect(unread).not.toHaveText('0');
  const before = Number(await unread.textContent());
  await expect(domBadge).toHaveText(String(before));
  await item.getByRole('button', { name: 'Oznacz jako przeczytane' }).click();
  await expect(item.getByRole('button', { name: 'Oznacz jako przeczytane' })).toHaveCount(0);
  await expect(unread).toHaveText(String(before - 1));
  if (before > 1) await expect(domBadge).toHaveText(String(before - 1));
  else await expect(domBadge).toHaveCount(0);
});
