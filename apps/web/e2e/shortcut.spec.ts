import { expect, test } from '@playwright/test';
import { loginAs } from './helpers';

/**
 * Skrót Siri: klucz z Ustawień (widoczny raz), pytanie tak jak z aplikacji Skróty (bez ciasteczka,
 * tylko klucz) → odpowiedź zwykłym tekstem, a rozmowa „Siri” w czacie. Tryb demo — bez modelu.
 */
test('Skrót Siri: klucz, pytanie z kluczem, odpowiedź tekstem i rozmowa „Siri”', async ({
  page,
  playwright,
}, testInfo) => {
  const question = `Co mam dziś? ${testInfo.project.name}-${Date.now()}`;
  await loginAs(page, 'Alfa (test)');
  await page.goto('/#/settings');
  const panel = page.getByRole('region', { name: 'Skrót Siri' });
  await expect(panel.getByRole('button', { name: /Utwórz klucz skrótu|Nowy klucz/ })).toBeVisible();
  // Oba projekty (desktop, telefon) dzielą bazę — drugi zastępuje klucz pierwszego.
  const create = panel.getByRole('button', { name: 'Utwórz klucz skrótu' });
  if (await create.isVisible()) await create.click();
  else {
    page.once('dialog', (d) => void d.accept());
    await panel.getByRole('button', { name: 'Nowy klucz' }).click();
  }
  const key = await panel.getByRole('textbox', { name: 'Klucz skrótu' }).inputValue();
  expect(key).toMatch(/^nova_siri_/);
  await expect(panel.getByText('klucz aktywny')).toBeVisible();
  await panel.getByText('Jak ustawić skrót na iPhonie').click();
  await expect(panel).toContainText('/api/shortcut/ask');

  // Osobny kontekst żądań: bez ciasteczek sesji, jak aplikacja Skróty.
  const shortcuts = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
  const res = await shortcuts.post('/api/shortcut/ask', {
    headers: { authorization: `Bearer ${key}` },
    data: { question },
    timeout: 30_000,
  });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/^text\/plain/);
  expect(await res.text()).toContain(`Otrzymałem: „${question}”`);
  await shortcuts.dispose();

  const convs = (await (await page.request.get('/api/conversations?space=private')).json()) as {
    items: Array<{ id: string; title: string }>;
  };
  const siri = convs.items.find((c) => c.title === 'Siri');
  expect(siri).toBeTruthy();
  await page.goto(`/#/chat/private/${siri!.id}`);
  await expect(page.getByText(question).first()).toBeVisible();
  await expect(page.getByText(`Otrzymałem: „${question}”`)).toBeVisible();
});
