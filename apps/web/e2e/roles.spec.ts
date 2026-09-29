import { expect, test } from '@playwright/test';
import { loginAs, shot } from './helpers';

/** Role w domu: właściciel widzi ustawienia administracyjne, domownik — prosty widok (czaty, pamięć, dokumenty). */
const navName = () =>
  test.info().project.name === 'phone' ? 'Nawigacja mobilna' : 'Nawigacja główna';

test('domownik: prosty widok bez modeli, usług, zadań i panelu aktywności', async ({ page }) => {
  await loginAs(page, 'Beta (test)');
  const nav = page.getByRole('navigation', { name: navName() });
  await expect(nav).toContainText('Czat');
  await expect(nav).toContainText('Pamięć');
  await expect(nav).toContainText('Dokumenty');
  for (const hidden of ['Modele AI', 'Usługi i koszty', 'Zadania'])
    await expect(nav.getByRole('link', { name: hidden })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Aktywność' })).toHaveCount(0);

  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: 'Wygląd' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Konto' })).toBeVisible();
  for (const hidden of [
    'Stan usług',
    'Koszt modeli (bieżący miesiąc)',
    'Modele AI i klucze API',
    'Domownicy',
  ])
    await expect(page.getByRole('heading', { name: hidden })).toHaveCount(0);
  await shot(page, '41-member-settings');

  // Paleta poleceń: „klucze api” nie prowadzi do modeli — tylko pytanie do asystenta.
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('klucze api');
  await expect(page.getByRole('option').first()).toContainText('Zapytaj asystenta');
  await expect(page.getByRole('option', { name: /Modele AI/ })).toHaveCount(0);
});

test('właściciel: pełne menu i ustawienia administracyjne', async ({ page }) => {
  await loginAs(page, 'Alfa (test)');
  const nav = page.getByRole('navigation', { name: navName() });
  if (test.info().project.name !== 'phone') {
    await expect(nav).toContainText('Modele AI');
    await expect(nav).toContainText('Usługi i koszty');
  }
  await expect(nav).toContainText('Zadania');
  await expect(page.getByRole('complementary', { name: 'Aktywność' })).toHaveCount(0);
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: 'Stan usług' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Modele AI i klucze API' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Domownicy' })).toBeVisible();
});
