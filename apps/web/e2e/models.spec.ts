import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * „Modele AI i klucze API” w UI: dodanie dostawcy z kluczem (widać tylko 4 ostatnie znaki), model z cennikiem
 * i kursem waluty, widok domownika tylko do odczytu, usunięcie. Bez żadnych wywołań dostawców: adres to domena
 * .test (nigdy nie istnieje), dostawca jest wyłączony przed dodaniem modelu, a „Sprawdź klucz” nie jest klikane.
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

// Wartość testowa — nie jest kluczem żadnego dostawcy i nigdy nie jest nigdzie wysyłana.
const FAKE_KEY = 'e2e-not-a-real-key-0000000000-T3ST';

test('dostawca modeli: klucz tylko do zapisu, model z cennikiem, domownik tylko czyta', async ({
  page,
}) => {
  const project = test.info().project.name;
  const name = `e2e-${project}`;
  const label = `Serwer testowy ${project}`;
  await loginAs(page, 'Alfa (test)');
  await page.goto('/#/settings');
  await page
    .locator('section.panel')
    .filter({ has: page.getByRole('heading', { name: 'Modele AI i klucze API' }) })
    .getByRole('link', { name: 'Otwórz' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Modele AI i klucze API', level: 1 }),
  ).toBeVisible();
  await expect(page.getByLabel('Stan asystenta')).toContainText('tryb demo');

  await page.getByRole('button', { name: 'Dodaj dostawcę' }).click();
  const form = page.locator('.model-form').first();
  // Gotowe ustawienia dostawców z linkiem do utworzenia klucza.
  await expect(form.getByRole('radio', { name: 'Anthropic (Claude)' })).toBeChecked();
  await expect(form.getByRole('link', { name: 'Gdzie utworzyć klucz' })).toHaveAttribute(
    'href',
    /platform\.claude\.com/,
  );
  await form.getByRole('radio', { name: 'Google Gemini' }).check();
  await expect(form.getByLabel(/Adres serwera/)).toHaveValue(/generativelanguage\.googleapis\.com/);
  await form.getByRole('radio', { name: 'Inny (zgodny z OpenAI)' }).check();
  await form.getByLabel('Nazwa wyświetlana').fill(label);
  await form.getByLabel(/Nazwa w NovaAI/).fill(name);
  await form.getByLabel(/Adres serwera/).fill('https://models.example.test/v1');
  const keyInput = form.getByLabel(/Klucz API/);
  await expect(keyInput).toHaveAttribute('type', 'password');
  await keyInput.fill(FAKE_KEY);
  await form.getByRole('button', { name: 'Zapisz dostawcę' }).click();

  const item = page.locator('.provider-item').filter({ hasText: label });
  await expect(item).toBeVisible();
  await expect(item.locator('.key-hint')).toHaveText('•••• T3ST');
  await expect(page.locator('body')).not.toContainText(FAKE_KEY);
  await expect(item.locator('.badge').first()).toHaveText('gotowy');

  // Wyłączony dostawca => model nie będzie używany (żadnych wywołań w teście).
  await item.getByRole('button', { name: 'Wyłącz' }).click();
  await expect(item.locator('.badge').first()).toHaveText('dostawca wyłączony');

  await page.getByRole('button', { name: 'Dodaj model' }).click();
  const mform = page.locator('.model-form').first();
  await mform.getByLabel('Dostawca').selectOption({ label });
  await mform.getByLabel('Identyfikator modelu u dostawcy').fill(`Test-Model/${project}`);
  await expect(mform.getByLabel('Nazwa w NovaAI')).toHaveValue(`test-model-${project}`);
  await mform.getByLabel('Cena wejścia (za 1 mln tokenów)').fill('abc');
  await mform.getByLabel('Cena wyjścia (za 1 mln tokenów)').fill('2');
  await mform.getByRole('button', { name: 'Dodaj model' }).click();
  await expect(mform.getByRole('alert')).toContainText('Ceny: liczby');
  await mform.getByLabel('Cena wejścia (za 1 mln tokenów)').fill('0,5');
  await mform.getByRole('button', { name: 'Dodaj model' }).click();

  const model = page.locator('.model-item').filter({ hasText: `test-model-${project}` });
  await expect(model).toContainText('0,5 / 2 USD za mln tokenów');
  await expect(model.locator('.badge')).toHaveText('dostawca wyłączony');
  await expect(page.getByRole('status').filter({ hasText: 'Brak kursu USD→PLN' })).toBeVisible();
  await page.getByLabel('Kurs USD w PLN').fill('3,95');
  await page.getByRole('button', { name: 'Zapisz kurs' }).click();
  await expect(page.getByText('1 USD = 3,95 PLN')).toBeVisible();
  await expect(page.getByText('Brak kursu USD→PLN')).toHaveCount(0);
  await expect(page.getByLabel('Stan asystenta')).toContainText('tryb demo');
  await shot(page, '17-models');

  // Domownik: widzi stan i końcówkę klucza, bez przycisków zmian.
  await page.goto('/#/settings');
  await page.getByRole('button', { name: 'Wyloguj' }).last().click();
  await loginAs(page, 'Beta (test)');
  await page.goto('/#/models');
  const seen = page.locator('.provider-item').filter({ hasText: label });
  await expect(seen.locator('.key-hint')).toHaveText('•••• T3ST');
  await expect(page.getByText('tylko do odczytu')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dodaj dostawcę' })).toHaveCount(0);
  await expect(seen.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Zapisz kurs' })).toHaveCount(0);

  // Właściciel usuwa dostawcę razem z modelem.
  await page.goto('/#/settings');
  await page.getByRole('button', { name: 'Wyloguj' }).last().click();
  await loginAs(page, 'Alfa (test)');
  await page.goto('/#/models');
  page.once('dialog', (d) => void d.accept());
  await page
    .locator('.provider-item')
    .filter({ hasText: label })
    .getByRole('button', { name: 'Usuń' })
    .click();
  await expect(page.locator('.provider-item').filter({ hasText: label })).toHaveCount(0);
  await expect(
    page.locator('.model-item').filter({ hasText: `test-model-${project}` }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Usuń' }).last().click(); // kurs USD
  await expect(page.getByText('1 USD = 3,95 PLN')).toHaveCount(0);
});

test('klucz z .env serwera: stan „brak cennika”, preset bez błędu nazwy, cennik uzupełniony w aplikacji', async ({
  page,
}) => {
  await loginAs(page, 'Alfa (test)');
  await page.goto('/#/models');
  // Klucz z pliku .env jest wczytany, ale model z pliku nie ma cennika — widać to wprost.
  const server = page.locator('.server-config');
  await expect(server.locator('.server-provider')).toContainText('klucz wczytany');
  await expect(server.locator('.server-provider')).toContainText('E2E_ANTHROPIC_API_KEY');
  await expect(page.locator('body')).not.toContainText('e2e-not-a-real-key');
  const fileModel = server.locator('.file-model').filter({ hasText: 'claude-fast' });
  await expect(fileModel.locator('.badge')).toHaveText('brak cennika');

  // Preset „Anthropic” ma tę samą nazwę co dostawca z pliku — podpowiedź zamiast błędu.
  await page.getByRole('button', { name: 'Dodaj dostawcę' }).click();
  const pform = page.locator('.model-form').first();
  await expect(pform.getByRole('note')).toContainText('Na serwerze jest już dostawca „anthropic”');
  await pform.getByRole('button', { name: 'Anuluj' }).click();

  // „Uzupełnij cennik”: dostawca z serwera (bez wpisywania klucza), nazwa i model z pliku.
  await fileModel.getByRole('button', { name: 'Uzupełnij cennik' }).click();
  const mform = page.locator('.model-form').first();
  await expect(mform.getByLabel('Dostawca')).toHaveValue('s:anthropic');
  await expect(mform.getByLabel('Nazwa w NovaAI')).toHaveValue('claude-fast');
  await expect(mform.getByLabel('Identyfikator modelu u dostawcy')).toHaveValue('claude-e2e');
  await mform.getByLabel('Waluta cennika').fill('PLN');
  await mform.getByLabel('Cena wejścia (za 1 mln tokenów)').fill('1');
  await mform.getByLabel('Cena wyjścia (za 1 mln tokenów)').fill('5');
  await mform.getByRole('button', { name: 'Dodaj model' }).click();
  const model = page.locator('.model-item').filter({ hasText: 'claude-fast' });
  await expect(model).toContainText('anthropic (klucz z serwera)/claude-e2e');
  await expect(model).toContainText('zastępuje model z pliku serwera');
  await expect(page.getByLabel('Stan asystenta')).toContainText('odpowiada prawdziwy model');
  await expect(fileModel.locator('.badge')).toHaveText('zastąpiony modelem z aplikacji');
  await shot(page, '18-models-server-key');

  // Sprzątanie od razu (bez żadnej rozmowy): usunięcie modelu przywraca tryb demo.
  page.once('dialog', (d) => void d.accept());
  await model.getByRole('button', { name: 'Usuń' }).click();
  await expect(page.getByLabel('Stan asystenta')).toContainText('tryb demo');
  await expect(fileModel.locator('.badge')).toHaveText('brak cennika');
});
