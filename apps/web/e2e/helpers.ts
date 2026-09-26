import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Wspólne pomocniki e2e. Zrzuty ekranów: z E2E_SCREENSHOTS=1 trafiają do docs/screens (dokumentacja),
 * w przeciwnym razie do test-results (ignorowane przez Git).
 */
const SCREENS = process.env.E2E_SCREENSHOTS
  ? resolve(import.meta.dirname, '../../../docs/screens')
  : resolve(import.meta.dirname, '../test-results/screens');
mkdirSync(SCREENS, { recursive: true });

export async function shot(page: Page, name: string): Promise<void> {
  const project = test.info().project.name;
  await page.screenshot({ path: resolve(SCREENS, `${project}-${name}.png`), fullPage: false });
}

export async function loginAs(page: Page, who: 'Alfa (test)' | 'Beta (test)'): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Wybierz konto testowe' })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(who.replace(/[()]/g, '\\$&')) }).click();
  await expect(page.locator('.envbar')).toContainText(who);
}

export async function logout(page: Page): Promise<void> {
  await page.goto('/#/settings');
  await page.getByRole('button', { name: 'Wyloguj' }).last().click();
  await expect(page.getByRole('heading', { name: 'Wybierz konto testowe' })).toBeVisible();
}

/**
 * Nowa rozmowa gotowa do pisania. Na desktopie lista otwiera najnowszą rozmowę automatycznie — pole wiadomości
 * bywa więc widoczne, zanim otworzy się nowa rozmowa (wpisany tekst przepadłby po przełączeniu). Czekamy na pusty
 * stan nowej rozmowy.
 */
export async function newConversation(
  page: Page,
  space: 'private' | 'shared' = 'private',
): Promise<void> {
  await page.goto(`/#/chat/${space}`);
  await page.getByRole('button', { name: 'Nowa' }).click();
  await expect(page.getByText('Napisz pierwszą wiadomość')).toBeVisible();
}
