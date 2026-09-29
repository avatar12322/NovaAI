import { expect, test } from '@playwright/test';
import { loginAs, logout, shot } from './helpers';

/** Wydatki: wspólny wydatek domownika widzi właściciel, osobista rata z „Zapłacone”. */
test('wydatki wspólne i osobiste, rata oznaczona jako zapłacona', async ({ page }) => {
  const tag = `${test.info().project.name}-${Date.now()}`;
  await loginAs(page, 'Beta (test)');
  await page.goto('/#/expenses');
  const form = page.getByRole('form', { name: 'Dodaj wydatek' });
  await form.getByLabel('Kwota').fill('120,50');
  await form.getByLabel('Kategoria').selectOption('dom');
  await form.getByLabel('Opis').fill(`Farba ${tag}`);
  await form.getByRole('button', { name: 'Dodaj' }).click();
  await expect(page.locator('.expense-list')).toContainText(`Farba ${tag}`);
  await logout(page);

  await loginAs(page, 'Alfa (test)');
  await page.goto('/#/expenses');
  await page.getByRole('tab', { name: 'Wspólne' }).click();
  const row = page.locator('.expense-item').filter({ hasText: `Farba ${tag}` });
  await expect(row).toContainText('120,50');
  await expect(row).toContainText('Beta (test)');
  await expect(row.getByRole('button')).toHaveCount(0); // cudzego nie usuwa

  const pay = page.getByRole('form', { name: 'Dodaj płatność' });
  await pay.getByLabel('Nazwa płatności').fill(`Rata ${tag}`);
  await pay.getByLabel('Kwota płatności').fill('450');
  await pay.getByLabel('Dzień miesiąca').fill('31');
  await pay.getByRole('button', { name: 'Dodaj płatność' }).click();
  const item = page.locator('.payment-item').filter({ hasText: `Rata ${tag}` });
  await item.getByRole('button', { name: 'Zapłacone' }).click();
  await expect(item).toContainText('zapłacone');
  await page.getByRole('tab', { name: 'Moje' }).click();
  await expect(page.locator('.expense-list')).toContainText(`Rata ${tag}`);
  await page.getByRole('heading', { name: 'Wydatki' }).scrollIntoViewIfNeeded();
  await shot(page, '43-expenses');
  // Sprzątanie: zakończenie płatności (baza e2e wspólna dla projektów).
  page.once('dialog', (d) => void d.accept());
  await item.getByRole('button', { name: 'Zakończ' }).click();
  await expect(item).toHaveCount(0);
});
