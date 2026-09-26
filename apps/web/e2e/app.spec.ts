import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Smoke/e2e UI na prawdziwym API (baza nova_e2e) — desktop i telefon.
 * Zrzuty ekranów: z E2E_SCREENSHOTS=1 trafiają do docs/screens (dokumentacja),
 * w przeciwnym razie do test-results (ignorowane przez Git).
 */
const SCREENS = process.env.E2E_SCREENSHOTS
  ? resolve(import.meta.dirname, '../../../docs/screens')
  : resolve(import.meta.dirname, '../test-results/screens');
mkdirSync(SCREENS, { recursive: true });

async function shot(page: Page, name: string) {
  const project = test.info().project.name;
  await page.screenshot({ path: resolve(SCREENS, `${project}-${name}.png`), fullPage: false });
}

async function loginAs(page: Page, who: 'Alfa (test)' | 'Beta (test)') {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Wybierz konto testowe' })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(who.replace(/[()]/g, '\\$&')) }).click();
  await expect(page.locator('.envbar')).toContainText(who);
}

async function logout(page: Page) {
  await page.goto('/#/settings');
  await page.getByRole('button', { name: 'Wyloguj' }).last().click();
  await expect(page.getByRole('heading', { name: 'Wybierz konto testowe' })).toBeVisible();
}

test('logowanie testowe, czat prywatny, pamięć i jawne udostępnienie', async ({ page }) => {
  const tag = `${test.info().project.name}-${Date.now()}`;
  await loginAs(page, 'Alfa (test)');
  await shot(page, '01-chat-empty');

  await page.getByRole('button', { name: 'Nowa' }).click();
  const input = page.getByLabel('Wiadomość');
  await expect(input).toBeVisible();
  await input.fill(`zapamiętaj: herbata jaśminowa ${tag}`);
  await input.press('Enter');
  await expect(page.locator('.msg-assistant').filter({ hasText: 'Proponuję zapisać' })).toBeVisible(
    { timeout: 15_000 },
  );
  await expect(page.locator('.msg-assistant .badge').first()).toHaveText('demo');
  await shot(page, '02-chat-private');

  await page.goto('/#/memory/private');
  const item = page.locator('.memory').filter({ hasText: tag });
  await expect(item).toBeVisible({ timeout: 10_000 });
  await item.getByRole('button', { name: 'Udostępnij' }).click();
  await page.getByRole('tab', { name: 'Wspólne' }).click();
  await expect(page.locator('.memory').filter({ hasText: tag })).toBeVisible();
  await shot(page, '03-memory-shared');

  // Beta widzi wpis wspólny, ale nie prywatne wpisy Alfy.
  await logout(page);
  await loginAs(page, 'Beta (test)');
  await page.goto('/#/memory/shared');
  await expect(page.locator('.memory').filter({ hasText: tag })).toBeVisible();
  await page.goto('/#/memory/private');
  await expect(page.getByText(tag)).toHaveCount(0);
});

test('zadanie z postępem, Approval Center i wiadomość do domownika', async ({ page }) => {
  const msg = `Kupię mleko (${test.info().project.name}-${Date.now()})`;
  await loginAs(page, 'Alfa (test)');
  await page.goto('/#/tasks');
  await page.getByRole('button', { name: 'Zadanie demonstracyjne' }).click();
  await page.getByLabel('Wiadomość do domownika').fill(msg);
  await page.getByRole('button', { name: 'Utwórz' }).click();
  const row = page.locator('.list-item').filter({ hasText: 'Zadanie demonstracyjne' }).first();
  await expect(row.getByText('czeka na zgodę')).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(page.locator('.step').filter({ hasText: 'Wyślij wiadomość' })).toContainText(
    'czeka na zgodę',
  );
  await shot(page, '04-task-waiting');

  await page.goto('/#/approvals');
  const card = page.locator('.approval').filter({ hasText: msg });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Beta (test)');
  await shot(page, '05-approval-center');
  await card.getByRole('button', { name: 'Zatwierdź' }).click();
  await expect(page.getByText('Nic nie czeka na Twoją zgodę')).toBeVisible({ timeout: 10_000 });

  await page.goto('/#/tasks');
  await expect(
    page
      .locator('.list-item')
      .filter({ hasText: 'Zadanie demonstracyjne' })
      .first()
      .getByText('zakończone'),
  ).toBeVisible({
    timeout: 15_000,
  });

  await logout(page);
  await loginAs(page, 'Beta (test)');
  await page.goto('/#/home');
  await expect(page.locator('.notification').filter({ hasText: msg })).toBeVisible();
  await shot(page, '06-home-beta');
});

test('NovaAI: rozmowa wspólna widoczna dla obojga', async ({ page }) => {
  const text = `lista zakupów ${test.info().project.name}-${Date.now()}`;
  await loginAs(page, 'Alfa (test)');
  await page.goto('/#/chat/shared');
  await page.getByRole('button', { name: 'Nowa' }).click();
  await page.getByLabel('Wiadomość').fill(text);
  await page.getByLabel('Wiadomość').press('Enter');
  await expect(page.locator('.msg-assistant').filter({ hasText: 'NovaAI' }).last()).toBeVisible({
    timeout: 15_000,
  });
  await shot(page, '07-novaai-shared');
  await logout(page);
  await loginAs(page, 'Beta (test)');
  await page.goto('/#/chat/shared');
  // Tytuł wspólnej rozmowy pochodzi z pierwszej wiadomości — Beta znajduje ją na liście po treści.
  await page.locator('.list-item').filter({ hasText: text }).click();
  await expect(page.locator('.msg-body').filter({ hasText: text })).toBeVisible();
});

test('ustawienia pokazują stan usług i tryb demo; baner offline', async ({ page, context }) => {
  await loginAs(page, 'Alfa (test)');
  await page.goto('/#/settings');
  await expect(page.getByText('Stan usług')).toBeVisible();
  await expect(page.getByText('Baza danych')).toBeVisible();
  await shot(page, '08-settings');
  await context.setOffline(true);
  await expect(page.getByText('Jesteś offline')).toBeVisible();
  await context.setOffline(false);
});

test('nawigacja klawiaturą: link „Przejdź do treści” jest pierwszym fokusem', async ({ page }) => {
  await loginAs(page, 'Alfa (test)');
  // Poczekaj na ustalenie widoku (desktop automatycznie otwiera ostatnią rozmowę), potem zacznij od body.
  await page.goto('/#/settings');
  await expect(page.getByText('Stan usług')).toBeVisible();
  // Ustaw punkt startowy nawigacji sekwencyjnej na początku dokumentu (body).
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute('tabindex');
  });
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Przejdź do treści' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
});
