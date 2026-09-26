import { expect, test } from '@playwright/test';
import { loginAs, shot } from './helpers';

/** Paleta poleceń (Ctrl+K): przejścia, wyszukiwanie bez polskich znaków, Esc, pytanie do asystenta z palety. */
test('paleta poleceń: przejście, wyszukiwanie, pytanie do asystenta', async ({ page }) => {
  await loginAs(page, 'Alfa (test)');
  const dialog = page.getByRole('dialog', { name: 'Polecenia' });
  const input = dialog.getByRole('combobox');

  await page.keyboard.press('Control+k');
  await expect(dialog).toBeVisible();
  await expect(input).toBeFocused();
  await input.fill('zadania');
  await expect(dialog.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('option').first()).toContainText('Zadania');
  await input.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/#\/tasks$/);

  // Przycisk (na telefonie w nagłówku, na komputerze w menu) i wyszukiwanie bez polskich znaków.
  await page
    .getByRole('button', { name: /^Polecenia/ })
    .filter({ visible: true })
    .first()
    .click();
  await input.fill('USLUGI');
  await expect(dialog.getByRole('option').first()).toContainText('Usługi i koszty');
  await input.press('ArrowDown');
  await expect(dialog.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
  await shot(page, '22-command-palette');
  // Po animacji wejścia (shot czeka na jej koniec) panel jest w pełni nieprzezroczysty — pisanie jej nie restartuje.
  await expect(dialog).toHaveCSS('opacity', '1');
  await input.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Pytanie prosto z palety: nowa rozmowa, pytanie wysłane, odpowiedź asystenta.
  await page.keyboard.press('Control+k');
  await input.fill('co pamiętasz?');
  await expect(dialog.getByRole('option').first()).toContainText(
    'Zapytaj asystenta: „co pamiętasz?”',
  );
  await input.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/#\/chat\/private\/[0-9a-f-]{36}$/);
  await expect(page.locator('.msg-mine').last()).toContainText('co pamiętasz?');
  await expect(page.locator('.msg-assistant').last()).toContainText('tryb demo', {
    timeout: 10_000,
  });
});
