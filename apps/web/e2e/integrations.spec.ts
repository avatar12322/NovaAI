import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Integracja Microsoft (Outlook) w UI BEZ konta Microsoft: stan „nie połączono”, wybór uprawnień,
 * informacja o Teams, komunikat o wymaganej zgodzie administratora, czytelna odmowa w czacie.
 * Przekierowanie do login.microsoftonline.com jest przechwytywane w przeglądarce — żadne żądanie
 * nie trafia do Microsoft.
 */
const SCREENS = process.env.E2E_SCREENSHOTS
  ? resolve(import.meta.dirname, '../../../docs/screens')
  : resolve(import.meta.dirname, '../test-results/screens');
mkdirSync(SCREENS, { recursive: true });
const shot = (page: Page, name: string) =>
  page.screenshot({ path: resolve(SCREENS, `${test.info().project.name}-${name}.png`) });

async function loginAlfa(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Alfa \(test\)/ }).click();
  await expect(page.locator('.envbar')).toContainText('Alfa (test)');
}

const card = (page: Page) =>
  page.locator('.integration').filter({ hasText: 'Microsoft (Outlook: poczta i kalendarz)' });

test('Microsoft: niepołączone konto, minimalne uprawnienia, Teams i zgoda administratora', async ({
  page,
}) => {
  await loginAlfa(page);
  await page.goto('/#/settings');
  const ms = card(page);
  await expect(ms.locator('.badge')).toHaveText('nie połączono');
  await expect(ms).toContainText('asystent nie ma dostępu do tej poczty ani kalendarza');
  // Domyślnie tylko odczyt; wysyłka i szkice wymagają świadomego włączenia.
  await expect(ms.getByLabel(/Wyszukiwanie poczty/)).toBeChecked();
  await expect(ms.getByLabel(/Odczyt wydarzeń/)).toBeChecked();
  await expect(ms.getByLabel(/Wysyłka e-maili/)).not.toBeChecked();
  await expect(ms.getByLabel(/Szkice e-maili/)).not.toBeChecked();
  await expect(ms.getByText('Mail.ReadBasic')).toBeVisible();

  const teams = ms.locator('summary', { hasText: 'Microsoft Teams — wymaga zgody administratora' });
  await expect(teams).toBeVisible();
  await teams.click();
  await expect(ms).toContainText('ChannelMessage.Read.All');
  await ms.scrollIntoViewIfNeeded();
  await shot(page, '13-integrations-microsoft');

  // Połącz: adres logowania Microsoft z wybranymi (minimalnymi) uprawnieniami — przechwycony lokalnie.
  let authorize: URL | null = null;
  await page.route('https://login.microsoftonline.com/**', (route) => {
    authorize = new URL(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<p>Atrapa strony logowania (test)</p>',
    });
  });
  await ms.getByLabel(/Odczyt treści wiadomości/).uncheck();
  await ms.getByRole('button', { name: 'Połącz' }).click();
  await expect(page.getByText('Atrapa strony logowania (test)')).toBeVisible();
  const u = authorize as unknown as URL;
  expect(u.pathname).toBe('/common/oauth2/v2.0/authorize');
  expect(u.searchParams.get('client_id')).toBe('e2e-client-id');
  expect(u.searchParams.get('scope')).toBe(
    'offline_access openid profile https://graph.microsoft.com/Calendars.ReadBasic https://graph.microsoft.com/Mail.ReadBasic',
  );
  expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  expect(u.searchParams.get('redirect_uri')).toBe(
    'http://localhost:5174/api/connections/microsoft/callback',
  );

  // Powrót z odmową wynikającą z zasad organizacji: czytelny komunikat, parametry znikają z adresu.
  await page.goto('/#/settings?integration=error&provider=microsoft&reason=zgoda_administratora');
  const note = page
    .getByRole('status')
    .filter({ hasText: 'Nie udało się połączyć konta Microsoft' });
  await expect(note).toContainText('organizacja wymaga zgody administratora');
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(card(page).locator('.badge')).toHaveText('nie połączono');
});

test('połączone konto: „Zmień uprawnienia” dokłada wysyłkę bez odłączania konta', async ({
  page,
}) => {
  // Stan „połączono (tylko odczyt)” podstawiony w odpowiedzi serwera; zmiana idzie prawdziwym /start.
  await page.route('**/api/connections', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    for (const it of body.items)
      if (it.provider === 'microsoft')
        it.connection = {
          status: 'connected',
          scopes: [],
          capabilities: ['mail.search', 'mail.read', 'calendar.freebusy', 'calendar.read'],
          account: 'alfa@example.test',
          updatedAt: new Date().toISOString(),
          lastError: null,
        };
    return route.fulfill({ response: res, json: body });
  });
  let authorize: URL | null = null;
  await page.route('https://login.microsoftonline.com/**', (route) => {
    authorize = new URL(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<p>Atrapa zgody (test)</p>',
    });
  });
  await loginAlfa(page);
  await page.goto('/#/settings');
  const ms = card(page);
  await expect(ms.locator('.badge')).toHaveText('połączono');
  await expect(ms.locator('.cap-status')).toContainText('Wysyłka e-maili');
  await expect(ms.getByRole('checkbox')).toHaveCount(0);

  await ms.getByRole('button', { name: 'Zmień uprawnienia' }).click();
  // Wybór zaczyna się od obecnych uprawnień; Anuluj chowa go bez zmian.
  await expect(ms.getByLabel(/Wyszukiwanie poczty/)).toBeChecked();
  await expect(ms.getByLabel(/Wysyłka e-maili/)).not.toBeChecked();
  await ms.getByRole('button', { name: 'Anuluj' }).click();
  await expect(ms.getByRole('checkbox')).toHaveCount(0);

  await ms.getByRole('button', { name: 'Zmień uprawnienia' }).click();
  await ms.getByLabel(/Wysyłka e-maili/).check();
  await ms.getByRole('button', { name: 'Zapisz uprawnienia' }).click();
  await expect(page.getByText('Atrapa zgody (test)')).toBeVisible();
  // Obecne uprawnienia + wysyłka; Mail.Read obejmuje wyszukiwanie (bez osobnego Mail.ReadBasic).
  expect((authorize as unknown as URL).searchParams.get('scope')).toBe(
    'offline_access openid profile https://graph.microsoft.com/Calendars.ReadBasic https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send',
  );
});

test('czat: prośba o pocztę bez połączonego konta daje czytelny powód', async ({ page }) => {
  await loginAlfa(page);
  await page.goto('/#/chat/private');
  await page.getByRole('button', { name: 'Nowa' }).click();
  await expect(page.getByText('Napisz pierwszą wiadomość')).toBeVisible();
  const input = page.getByLabel('Wiadomość');
  await input.fill('szukaj maili outlook: faktura');
  await input.press('Enter');
  const reply = page.locator('.msg-assistant').last();
  await expect(reply).toContainText('tryb demo', { timeout: 15_000 });
  await expect(reply).toContainText(
    'Potrzebne konto (poczta, kalendarz lub Slack) nie jest połączone — połącz je w Ustawieniach → Integracje.',
  );
});

test('Slack: niepołączone konto, minimalne zakresy użytkownika, brak zapisu treści', async ({
  page,
}) => {
  await loginAlfa(page);
  await page.goto('/#/settings');
  const sl = page
    .locator('.integration')
    .filter({ hasText: 'Slack (wzmianki, wiadomości, wysyłka)' });
  await expect(sl.locator('.badge')).toHaveText('nie połączono');
  // Domyślnie tylko kanały publiczne; kanały prywatne, rozmowy bezpośrednie i wysyłka — świadomy wybór.
  await expect(sl.getByLabel(/kanałów publicznych/)).toBeChecked();
  await expect(sl.getByLabel(/kanały prywatne/)).not.toBeChecked();
  await expect(sl.getByLabel(/rozmowy bezpośrednie/)).not.toBeChecked();
  await expect(sl.getByLabel(/Wysyłanie wiadomości/)).not.toBeChecked();
  await expect(sl.getByText('search:read.public').first()).toBeVisible();
  const storage = sl.locator('summary', { hasText: 'Wyniki ze Slacka nie są zapisywane' });
  await storage.click();
  await expect(sl).toContainText('zabraniają przechowywania');
  await sl.scrollIntoViewIfNeeded();
  await shot(page, '14-integrations-slack');

  let authorize: URL | null = null;
  await page.route('https://slack.com/oauth/v2/authorize**', (route) => {
    authorize = new URL(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<p>Atrapa strony Slack (test)</p>',
    });
  });
  await sl.getByLabel(/Wysyłanie wiadomości/).check();
  await sl.getByRole('button', { name: 'Połącz' }).click();
  await expect(page.getByText('Atrapa strony Slack (test)')).toBeVisible();
  const u = authorize as unknown as URL;
  expect(u.searchParams.get('client_id')).toBe('e2e-slack-client');
  expect(u.searchParams.get('user_scope')).toBe(
    'channels:read,chat:write,groups:read,search:read.public',
  );
  expect(u.searchParams.has('scope')).toBe(false);
  expect(u.searchParams.get('redirect_uri')).toBe(
    'http://localhost:5174/api/connections/slack/callback',
  );

  await page.goto('/#/settings?integration=error&provider=slack&reason=account_in_use');
  await expect(
    page.getByRole('status').filter({ hasText: 'Nie udało się połączyć konta Slack' }),
  ).toContainText('połączone przez inną osobę');

  await page.goto('/#/chat/private');
  await page.getByRole('button', { name: 'Nowa' }).click();
  await expect(page.getByText('Napisz pierwszą wiadomość')).toBeVisible();
  const input = page.getByLabel('Wiadomość');
  await input.fill('wzmianki slack');
  await input.press('Enter');
  const reply = page.locator('.msg-assistant').last();
  await expect(reply).toContainText('tryb demo', { timeout: 15_000 });
  await expect(reply).toContainText(
    'Potrzebne konto (poczta, kalendarz lub Slack) nie jest połączone',
  );
});
