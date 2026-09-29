import { expect, test } from '@playwright/test';
import { loginAs, shot } from './helpers';

/** Terminy w „Dom” i nauka z fiszek w „Dokumenty”. */
const inDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};

test('termin kolokwium: dodanie, „za 5 dni”, zrobione', async ({ page }) => {
  const title = `Kolokwium ${test.info().project.name}-${Date.now()}`;
  await loginAs(page, 'Alfa (test)');
  await page.goto('/#/home');
  const form = page.getByRole('form', { name: 'Dodaj termin' });
  await form.getByLabel('Nazwa terminu').fill(title);
  await form.getByLabel('Przedmiot').fill('Analiza danych');
  await form.getByLabel('Data terminu').fill(inDays(5));
  await form.getByLabel('Godzina (opcjonalnie)').fill('10:00');
  await form.getByRole('button', { name: 'Dodaj termin' }).click();
  const item = page.locator('.deadline-item').filter({ hasText: title });
  await expect(item).toContainText('za 5 dni');
  await expect(item).toContainText('Analiza danych');
  await item.getByRole('checkbox').click();
  await expect(item).toHaveCount(0);
});

test('fiszki: nauka — pokaż odpowiedź, umiem / jeszcze nie, koniec powtórki', async ({ page }) => {
  const deck = `Talia ${test.info().project.name}-${Date.now()}`;
  await loginAs(page, 'Alfa (test)');
  const r = await page.request.post('/api/flashcards/decks', {
    headers: { 'x-nova-csrf': '1' },
    data: {
      title: deck,
      cards: [
        { front: 'Mediana?', back: 'Wartość środkowa' },
        { front: 'Moda?', back: 'Najczęstsza wartość' },
      ],
    },
  });
  expect(r.status()).toBe(201);
  await page.goto('/#/documents/private');
  const item = page.locator('.deck-item').filter({ hasText: deck });
  await item.getByRole('button', { name: 'Ucz się (2)' }).click();
  const study = page.getByRole('region', { name: `Nauka: ${deck}` });
  await expect(study).toContainText('Mediana?');
  await study.getByRole('button', { name: 'Pokaż odpowiedź' }).click();
  await expect(study).toContainText('Wartość środkowa');
  await shot(page, '44-flashcards');
  await study.getByRole('button', { name: 'Umiem' }).click();
  await expect(study).toContainText('Moda?');
  await study.getByRole('button', { name: 'Pokaż odpowiedź' }).click();
  await study.getByRole('button', { name: 'Jeszcze nie' }).click();
  await expect(study).toContainText('Koniec powtórki na dziś');
  await study.getByRole('button', { name: 'Wróć do talii' }).click();
  page.once('dialog', (d) => void d.accept());
  await item.getByRole('button', { name: 'Usuń' }).click();
  await expect(item).toHaveCount(0);
});
