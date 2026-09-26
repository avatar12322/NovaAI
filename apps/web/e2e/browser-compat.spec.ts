import { expect, test } from '@playwright/test';

/**
 * Zgodność z nowszymi przeglądarkami: metody przewijania (np. `scrollIntoView`) zwracają w nich Promise.
 * Efekt Reacta zwracający taką wartość wywracał całą aplikację („destroy is not a function” → czarny ekran).
 * Testowy Chromium zwraca jeszcze `undefined`, więc zachowanie nowszych przeglądarek jest tu symulowane.
 */
test('nowa rozmowa działa, gdy scrollIntoView zwraca Promise', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, ...args: unknown[]) {
      original.apply(this, args as Parameters<typeof original>);
      return Promise.resolve() as unknown as undefined;
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Alfa \(test\)/ }).click();
  await expect(page.locator('.envbar')).toContainText('Alfa (test)');
  await page.goto('/#/chat/private');
  await page.getByRole('button', { name: 'Nowa' }).click();
  await expect(page.getByText('Napisz pierwszą wiadomość')).toBeVisible();
  const input = page.getByLabel('Wiadomość');
  await input.fill('test przewijania');
  await input.press('Enter');
  await expect(page.locator('.msg-assistant').last()).toContainText('tryb demo', {
    timeout: 15_000,
  });
  // Ponowne wejście w rozmowę (odmontowanie i zamontowanie widoku) też nie może się wywrócić.
  await page.reload();
  await expect(page.locator('.msg-assistant').last()).toContainText('tryb demo');
  expect(errors).toEqual([]);
});

test('błąd w widoku: komunikat zamiast pustego ekranu, nawigacja działa', async ({ page }) => {
  await page.addInitScript(() => {
    Element.prototype.scrollIntoView = () => {
      throw new Error('symulowany błąd przeglądarki');
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Alfa \(test\)/ }).click();
  await expect(page.locator('.envbar')).toContainText('Alfa (test)');
  await page.goto('/#/chat/private');
  await page.getByRole('button', { name: 'Nowa' }).click();
  const alert = page.locator('.view-error');
  await expect(alert).toContainText('Ten widok nie mógł się wyświetlić');
  await expect(alert).toContainText('symulowany błąd przeglądarki');
  // Reszta aplikacji działa: przejście do innego widoku czyści błąd.
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: 'Ustawienia' })).toBeVisible();
  await expect(page.locator('.view-error')).toHaveCount(0);
});
