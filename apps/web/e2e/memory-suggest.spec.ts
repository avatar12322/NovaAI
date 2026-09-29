import { expect, test } from '@playwright/test';
import { loginAs, newConversation } from './helpers';

/**
 * Zgoda wprost w czacie: propozycja asystenta („Zapamiętać: …?”) pod jego wiadomością, z przyciskami
 * Zatwierdź / Odrzuć. Tryb demo: polecenie „zaproponuj zapamiętanie:” zastępuje decyzję modelu.
 */
test('propozycja zapamiętania: zatwierdzona trafia do pamięci, odrzucona nie', async ({
  page,
}, testInfo) => {
  const tag = `${testInfo.project.name}-${Date.now()}`;
  const yes = `Nie jem glutenu ${tag}`;
  const no = `Lubię ananasa na pizzy ${tag}`;
  await loginAs(page, 'Alfa (test)');
  await newConversation(page, 'private');

  const propose = async (fact: string) => {
    await page.getByLabel('Wiadomość').fill(`zaproponuj zapamiętanie: ${fact}`);
    await page.getByRole('button', { name: 'Wyślij' }).click();
    const card = page.getByRole('group', { name: `Zgoda: Zapamiętać: „${fact}”?` });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('pamięć prywatna');
    return card;
  };

  const first = await propose(yes);
  await first.getByRole('button', { name: 'Zatwierdź' }).click();
  await expect(first).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'Wynik akcji' }).last()).toContainText(
    'Zapis w pamięci',
    { timeout: 15_000 },
  );

  const second = await propose(no);
  await second.getByRole('button', { name: 'Odrzuć' }).click();
  await expect(second).toHaveCount(0);

  await page.goto('/#/memory/private');
  await expect(page.getByText(yes)).toBeVisible();
  await expect(page.getByText(no)).toHaveCount(0);
});
