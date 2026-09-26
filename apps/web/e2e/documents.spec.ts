import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { makePdf } from '../../api/src/test/pdf-fixture';

/**
 * Pamięć dokumentów w UI (tryb demo, bez modelu): dodanie PDF, wyszukiwanie, odpowiedź w czacie ze źródłem
 * (dokument + strona) i przejście do fragmentu; błędy plików; prywatny dokument Alfy niewidoczny dla Bety.
 */
const SCREENS = process.env.E2E_SCREENSHOTS
  ? resolve(import.meta.dirname, '../../../docs/screens')
  : resolve(import.meta.dirname, '../test-results/screens');
mkdirSync(SCREENS, { recursive: true });
const shot = (page: Page, name: string) =>
  page.screenshot({ path: resolve(SCREENS, `${test.info().project.name}-${name}.png`) });

async function loginAs(page: Page, who: 'Alfa (test)' | 'Beta (test)') {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(who.replace(/[()]/g, '\\$&')) }).click();
  await expect(page.locator('.envbar')).toContainText(who);
}

async function ask(page: Page, question: string) {
  await page.goto('/#/chat/private');
  await page.getByRole('button', { name: 'Nowa' }).click();
  // Nowa rozmowa jest otwarta dopiero, gdy widać jej pusty stan (wcześniej mogła być widoczna poprzednia).
  await expect(page.getByText('Napisz pierwszą wiadomość')).toBeVisible();
  const input = page.getByLabel('Wiadomość');
  await input.fill(question);
  await input.press('Enter');
  const reply = page.locator('.msg-assistant').last();
  await expect(reply).toContainText('tryb demo', { timeout: 15_000 });
  return reply;
}

test('dokument PDF: dodanie, wyszukanie, odpowiedź ze źródłem i fragment; izolacja od Bety', async ({
  page,
}) => {
  const tag = `${test.info().project.name}-${Date.now()}`;
  const pdf = makePdf([
    ['Umowa najmu mieszkania', `Egzemplarz ${tag}`],
    ['Kaucja wynosi 3000 zl i jest zwracana w ciagu 30 dni.'],
    ['Okres wypowiedzenia wynosi trzy miesiace.'],
  ]);

  await loginAs(page, 'Alfa (test)');
  await page.goto('/#/documents');
  await expect(
    page.getByText('Nie masz jeszcze dokumentów').or(page.locator('.document')),
  ).toBeVisible();

  // Walidacja w przeglądarce i odpowiedź serwera dla pliku, który tylko udaje PDF.
  await page.setInputFiles('#doc-file', {
    name: 'notatki.docx',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('x'),
  });
  await expect(page.getByRole('alert').filter({ hasText: 'nieobsługiwany format' })).toBeVisible();
  await page.setInputFiles('#doc-file', {
    name: 'udawany.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('to nie jest pdf'),
  });
  await expect(
    page.getByRole('alert').filter({ hasText: 'nie jest dokumentem PDF' }),
  ).toBeVisible();

  await page.setInputFiles('#doc-file', {
    name: `Umowa najmu ${tag}.pdf`,
    mimeType: 'application/pdf',
    buffer: pdf,
  });
  const item = page.locator('.document').filter({ hasText: `Umowa najmu ${tag}` });
  await expect(item.locator('.badge').filter({ hasText: 'gotowy' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(item).toContainText('3 str.');
  await shot(page, '10-documents');

  await page.getByLabel('Szukaj w dokumentach').fill('ile wynosi kaucja');
  await page.getByRole('button', { name: 'Szukaj' }).click();
  const hit = page
    .locator('.hit')
    .filter({ hasText: `Umowa najmu ${tag}` })
    .first();
  await expect(hit).toContainText('s. 2');
  await expect(hit.locator('mark').first()).toHaveText('Kaucja');

  const reply = await ask(page, 'Ile wynosi kaucja za mieszkanie?');
  await expect(reply).toContainText('Kaucja wynosi 3000 zl');
  const source = reply.locator('.source').filter({ hasText: `Umowa najmu ${tag}` });
  await expect(source).toContainText('s. 2');
  await shot(page, '11-chat-sources');
  await source.click();
  await expect(page.locator('.fragment-head')).toContainText('Fragment 2 z 3 · s. 2');
  await expect(page.locator('.fragment-body')).toContainText('Kaucja wynosi 3000 zl');
  await shot(page, '12-document-fragment');

  // Beta: brak dokumentu na liście, w wyszukiwaniu i w odpowiedzi asystenta.
  await page.goto('/#/settings');
  await page.getByRole('button', { name: 'Wyloguj' }).last().click();
  await loginAs(page, 'Beta (test)');
  await page.goto('/#/documents');
  await expect(page.getByText('Nie masz jeszcze dokumentów')).toBeVisible();
  await page.goto('/#/documents/shared');
  await expect(page.locator('.document').filter({ hasText: tag })).toHaveCount(0);
  await page.getByLabel('Szukaj w dokumentach').fill(`kaucja ${tag}`);
  await page.getByRole('button', { name: 'Szukaj' }).click();
  await expect(page.locator('.hit').filter({ hasText: tag })).toHaveCount(0);
  const betaReply = await ask(page, 'Ile wynosi kaucja za mieszkanie?');
  await expect(betaReply).not.toContainText('3000');
  await expect(betaReply.locator('.sources')).toHaveCount(0);
});
