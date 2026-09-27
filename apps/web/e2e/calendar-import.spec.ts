import { expect, test, type Page } from '@playwright/test';
import { loginAs, shot } from './helpers';

/**
 * Plan zajęć z pliku .ics (np. „Zapisz jako ical” w Wirtualnym Dziekanacie): wgranie w Ustawieniach, zajęcia
 * w przeglądzie dnia z salą, nowa wersja planu, usunięcie, czytelny błąd przy złym pliku. Dane zmyślone.
 */
const day = (offset: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' })
    .format(new Date(Date.now() + offset * 86_400_000))
    .replaceAll('-', '');
const ics = (...events: Array<[string, string, string, string, string]>) =>
  Buffer.from(
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//github.com/ical-org/ical.net//NONSGML ical.net 4.0//EN',
      ...events.flatMap(([uid, date, time, title, room]) => [
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTART;TZID=Europe/Warsaw:${date}T${time}00`,
        `DTEND;TZID=Europe/Warsaw:${date}T${String(Number(time.slice(0, 2)) + 1).padStart(2, '0')}${time.slice(2)}00`,
        `SUMMARY:${title}`,
        `LOCATION:${room}`,
        'END:VEVENT',
      ]),
      'END:VCALENDAR',
    ].join('\r\n'),
  );
const file = (name: string, buffer: Buffer) => ({ name, mimeType: 'text/calendar', buffer });
const section = (page: Page) => page.locator('.cal-imports');

test('plan zajęć: wgranie, przegląd dnia z salą, nowa wersja, usunięcie', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await loginAs(page, 'Alfa (test)');
  await page.goto('/#/settings');
  const box = section(page);
  await expect(box).toContainText('Nie wgrano jeszcze żadnego planu.');

  // Zły plik: czytelny powód.
  await box
    .getByLabel('Plik kalendarza (.ics)')
    .setInputFiles(file('plan.csv', Buffer.from('Czas od;Czas do')));
  await box.getByRole('button', { name: 'Wgraj' }).click();
  await expect(box.locator('.note-danger')).toHaveText('To nie jest plik kalendarza (.ics)');

  await box.getByLabel('Nazwa kalendarza').fill('Plan WSEI');
  await box
    .getByLabel('Plik kalendarza (.ics)')
    .setInputFiles(
      file(
        'Plany.ics',
        ics(
          ['1', day(0), '0800', 'Programowanie obiektowe', 'A-101'],
          ['2', day(1), '1000', 'Bazy danych', 'B-7'],
        ),
      ),
    );
  await box.getByRole('button', { name: 'Wgraj' }).click();
  await expect(box.getByRole('status')).toHaveText('Wgrano „Plan WSEI”: 2 wydarzenia.');
  // Pole pliku wyczyszczone — nie wygląda, jakby plik czekał na wgranie.
  await expect(box.getByLabel('Plik kalendarza (.ics)')).toHaveValue('');
  const item = box.getByRole('list', { name: 'Wgrane kalendarze' }).getByRole('listitem');
  await expect(item).toContainText('Plan WSEI');
  await expect(item).toContainText('2 wydarzenia');
  await expect(item).toContainText('najbliższe:');
  await box.locator('summary', { hasText: 'Jak pobrać plan' }).click();
  await expect(box).toContainText('Zapisz jako ical');
  await box.scrollIntoViewIfNeeded();
  await shot(page, '24-calendar-import');

  await page.goto('/#/home');
  const today = page.getByRole('region', { name: 'Przegląd dnia' }).locator('.briefing-item', {
    hasText: 'Dziś w kalendarzu',
  });
  await expect(today).toContainText('Programowanie obiektowe');
  await expect(today).toContainText('A-101');
  await expect(today).not.toContainText('Bazy danych');

  // Nowa wersja planu zastępuje poprzednią.
  await page.goto('/#/settings');
  await section(page)
    .getByLabel('Nowa wersja: Plan WSEI')
    .setInputFiles(file('Plany.ics', ics(['3', day(2), '1200', 'Sieci komputerowe', 'C-3'])));
  await expect(section(page).getByRole('status')).toHaveText('Wgrano „Plan WSEI”: 1 wydarzenie.');
  await page.goto('/#/home');
  await expect(
    page.getByRole('region', { name: 'Przegląd dnia' }).locator('.briefing-item', {
      hasText: 'Dziś w kalendarzu',
    }),
  ).not.toContainText('Programowanie obiektowe');

  await page.goto('/#/settings');
  await section(page).getByRole('button', { name: 'Usuń' }).click();
  await expect(section(page)).toContainText('Nie wgrano jeszcze żadnego planu.');
});
