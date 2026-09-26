import { expect, test } from '@playwright/test';
import { shot, loginAs, logout } from './helpers';

/**
 * „Usługi i koszty” w UI: dodanie usługi, szacunek → raport → faktura (liczona raz), przekroczony budżet,
 * adaptery „niepodłączone”, odrzucenie pola z hasłem, udostępnienie domownikowi (tylko odczyt).
 */

test('usługa: koszty bez podwójnego liczenia, budżet, adaptery niepodłączone, udostępnienie', async ({
  page,
}) => {
  const name = `VPS ${test.info().project.name}-${Date.now()}`;
  await loginAs(page, 'Alfa (test)');
  await page.goto('/#/services');
  await expect(page.getByRole('heading', { name: 'Usługi i koszty' })).toBeVisible();
  // Adaptery raportów bez kluczy na serwerze — „niepodłączone”.
  const adapters = page.locator('.device').filter({ hasText: 'raport kosztów organizacji' });
  await expect(adapters).toHaveCount(2);
  for (const a of await adapters.all())
    await expect(a.locator('.badge')).toHaveText('niepodłączone');

  await page.getByRole('button', { name: 'Dodaj usługę' }).click();
  const form = page.locator('.service-form').first();
  await form.getByLabel('Nazwa').fill(name);
  await form.getByLabel('Cel (do czego NovaAI tego używa)').fill('Serwer aplikacji');
  await form.getByLabel('Link do panelu (https)').fill('https://panel.example.test/servers');
  await form.getByLabel('Plan').fill('CX22');
  await form.getByLabel('Miesięczny budżet').fill('60');
  await form.getByLabel('Notatki (bez haseł i kluczy)').fill('hasło: Tajne123!');
  await form.getByRole('button', { name: 'Dodaj usługę' }).click();
  await expect(form.getByRole('alert')).toContainText('Nie wpisuj tu haseł ani kluczy API');
  await form.getByLabel('Notatki (bez haseł i kluczy)').fill('Faktury przychodzą mailem.');
  await form.getByRole('button', { name: 'Dodaj usługę' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();

  // Szacunek, raport i faktura za ten sam miesiąc — liczy się tylko faktura.
  const add = page.locator('section').filter({ hasText: 'Dodaj koszt' });
  const addEntry = async (kind: string, amount: string, extra?: () => Promise<void>) => {
    await add.getByLabel('Rodzaj').selectOption({ label: kind });
    await add.getByLabel('Kwota').fill(amount);
    if (extra) await extra();
    await add.getByRole('button', { name: 'Dodaj', exact: true }).click();
    await expect(add.getByRole('status')).toContainText('Dodano wpis');
  };
  await addEntry('szacunek', '50');
  await addEntry('raport dostawcy', '60');
  await addEntry('faktura', '70,00', async () => {
    await add.getByLabel('Numer faktury').fill('FV/1');
    await add
      .getByLabel('Data zapłaty (puste = do zapłaty)')
      .fill(new Date().toISOString().slice(0, 10));
  });
  const entries = page.locator('.cost-entries li');
  await expect(entries).toHaveCount(3);
  await expect(entries.filter({ hasText: 'faktura opłacona' })).not.toHaveClass(/not-counted/);
  await expect(entries.filter({ hasText: 'raport dostawcy' })).toHaveClass(/not-counted/);
  await expect(entries.filter({ hasText: 'szacunek' })).toContainText('niewliczony');
  await expect(page.locator('.budget-bar')).toContainText('przekroczony');
  // Ta sama faktura drugi raz — odrzucona.
  await add.getByLabel('Rodzaj').selectOption({ label: 'faktura' });
  await add.getByLabel('Kwota').fill('70');
  await add.getByLabel('Numer faktury').fill('fv/1');
  await add.getByRole('button', { name: 'Dodaj', exact: true }).click();
  await expect(add.getByRole('alert')).toContainText('Faktura nr fv/1 jest już zapisana');
  await page.locator('.service-facts').scrollIntoViewIfNeeded();
  await shot(page, '16-service-detail');

  await page.getByRole('link', { name: '← Usługi i koszty' }).click();
  const card = page.locator('.service-card').filter({ hasText: name });
  await expect(card).toContainText('70,00 zł');
  await expect(card.locator('.badge').filter({ hasText: 'faktura' })).toBeVisible();
  await expect(card).toContainText('przekroczony');
  await expect(page.locator('.cost-summary')).toContainText('faktura opłacona');
  await expect(page.locator('.cost-summary')).toContainText(`Przekroczony budżet:`);
  await shot(page, '15-services');

  // Filtry widoczności: prywatna usługa jest w „Prywatne”, nie w „Wspólne”; bez błędu serwera.
  await page.getByRole('tab', { name: 'Prywatne' }).click();
  await expect(page.locator('.service-card').filter({ hasText: name })).toBeVisible();
  await expect(page.getByText('Błąd serwera')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Wspólne' }).click();
  await expect(page.locator('.service-card').filter({ hasText: name })).toHaveCount(0);
  await expect(page.getByText('Błąd serwera')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Wszystkie' }).click();

  // Udostępnienie: Beta widzi usługę tylko do odczytu.
  await card.getByRole('link', { name }).click();
  await page.getByRole('button', { name: 'Udostępnij domownikom' }).click();
  await expect(page.getByRole('status').first()).toContainText('widoczna dla domowników');
  await logout(page);
  await loginAs(page, 'Beta (test)');
  await page.goto('/#/services');
  const shared = page.locator('.service-card').filter({ hasText: name });
  await expect(shared).toContainText('wspólna');
  await shared.getByRole('link', { name }).click();
  await expect(page.getByText('tylko do odczytu')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edytuj' })).toHaveCount(0);
  await expect(page.locator('section').filter({ hasText: 'Dodaj koszt' })).toHaveCount(0);
});
