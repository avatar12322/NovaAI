import { expect, test } from '@playwright/test';
import { loginAs, newConversation } from './helpers';

/** Zdjęcie w czacie: wybór pliku, miniatura, wysłanie, zdjęcie w wiadomości (serwowane z API). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

test('zdjęcie paragonu w czacie: miniatura, wysłanie, podgląd w wiadomości', async ({ page }) => {
  await loginAs(page, 'Alfa (test)');
  await newConversation(page, 'private');
  await page.getByLabel('Wybierz zdjęcie').setInputFiles({
    name: 'paragon.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  const pending = page.getByRole('list', { name: 'Zdjęcia do wysłania' });
  await expect(pending.getByRole('img')).toHaveCount(1);
  await page.getByLabel('Wiadomość').fill('ile wydałem?');
  await page.getByRole('button', { name: 'Wyślij' }).click();
  await expect(pending).toHaveCount(0);
  const sent = page.locator('.msg-mine').filter({ hasText: 'ile wydałem?' }).last();
  const img = sent.getByRole('img', { name: 'Zdjęcie w wiadomości' });
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
});
