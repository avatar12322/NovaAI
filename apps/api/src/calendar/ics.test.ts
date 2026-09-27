import { describe, expect, it } from 'vitest';
import { IcsError, parseIcs, wallClockToUtc } from './ics';

/** Plik iCalendar z liniami (CRLF jak w eksportach). Dane zmyślone. */
const ics = (...lines: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//plan//PL', ...lines, 'END:VCALENDAR'].join(
    '\r\n',
  );
const event = (...lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const WIDE = {
  from: new Date('2026-09-01T00:00:00Z'),
  to: new Date('2027-03-01T00:00:00Z'),
  maxEvents: 1000,
};
const iso = (d: Date) => d.toISOString();

describe('czas: strefa i zmiana czasu', () => {
  it('Europe/Warsaw bez definicji strefy w pliku; lato i zima', () => {
    const r = parseIcs(
      ics(
        ...event(
          'UID:1',
          'DTSTART;TZID=Europe/Warsaw:20261005T080000',
          'DTEND;TZID=Europe/Warsaw:20261005T093000',
          'SUMMARY:Programowanie obiektowe',
        ),
        ...event(
          'UID:2',
          'DTSTART;TZID=Europe/Warsaw:20261026T080000',
          'DTEND;TZID=Europe/Warsaw:20261026T093000',
          'SUMMARY:Bazy danych',
        ),
      ),
      WIDE,
    );
    expect(r.events.map((e) => [e.title, iso(e.startsAt), iso(e.endsAt)])).toEqual([
      ['Programowanie obiektowe', '2026-10-05T06:00:00.000Z', '2026-10-05T07:30:00.000Z'],
      ['Bazy danych', '2026-10-26T07:00:00.000Z', '2026-10-26T08:30:00.000Z'],
    ]);
  });

  it('nieznana strefa (nazwa z Windows) i czas bez strefy => Europe/Warsaw; UTC bez zmian', () => {
    const r = parseIcs(
      ics(
        ...event(
          'UID:w',
          'DTSTART;TZID=Central European Standard Time:20261005T100000',
          'DTEND;TZID=Central European Standard Time:20261005T113000',
          'SUMMARY:Windows',
        ),
        ...event('UID:f', 'DTSTART:20261005T120000', 'DTEND:20261005T130000', 'SUMMARY:Pływający'),
        ...event('UID:u', 'DTSTART:20261005T120000Z', 'DTEND:20261005T130000Z', 'SUMMARY:UTC'),
      ),
      WIDE,
    );
    expect(Object.fromEntries(r.events.map((e) => [e.title, iso(e.startsAt)]))).toEqual({
      Windows: '2026-10-05T08:00:00.000Z',
      Pływający: '2026-10-05T10:00:00.000Z',
      UTC: '2026-10-05T12:00:00.000Z',
    });
    expect(iso(wallClockToUtc(2027, 3, 28, 3, 0, 0, 'Europe/Warsaw'))).toBe(
      '2027-03-28T01:00:00.000Z',
    );
  });

  it('cały dzień: od północy w Polsce; brak DTEND => 1 godzina', () => {
    const r = parseIcs(
      ics(
        ...event('UID:d', 'DTSTART;VALUE=DATE:20261111', 'SUMMARY:Święto'),
        ...event('UID:n', 'DTSTART;TZID=Europe/Warsaw:20261005T140000', 'SUMMARY:Bez końca'),
      ),
      WIDE,
    );
    const [bez, swieto] = [r.events[0]!, r.events[1]!];
    expect([iso(bez.startsAt), iso(bez.endsAt)]).toEqual([
      '2026-10-05T12:00:00.000Z',
      '2026-10-05T13:00:00.000Z',
    ]);
    expect([iso(swieto.startsAt), iso(swieto.endsAt)]).toEqual([
      '2026-11-10T23:00:00.000Z',
      '2026-11-11T23:00:00.000Z',
    ]);
  });
});

describe('treść i powtórzenia', () => {
  it('co tydzień z wyjątkami: EXDATE, przeniesione zajęcia (RECURRENCE-ID), odwołane', () => {
    const r = parseIcs(
      ics(
        ...event(
          'UID:alg',
          'DTSTART;TZID=Europe/Warsaw:20261006T100000',
          'DTEND;TZID=Europe/Warsaw:20261006T113000',
          'RRULE:FREQ=WEEKLY;COUNT=4',
          'EXDATE;TZID=Europe/Warsaw:20261013T100000',
          'SUMMARY:Algorytmy',
          'LOCATION:Sala A\\, 101',
        ),
        ...event(
          'UID:alg',
          'RECURRENCE-ID;TZID=Europe/Warsaw:20261020T100000',
          'DTSTART;TZID=Europe/Warsaw:20261020T120000',
          'DTEND;TZID=Europe/Warsaw:20261020T133000',
          'SUMMARY:Algorytmy (zmiana sali)',
          'LOCATION:Sala B 7',
        ),
        ...event(
          'UID:x',
          'DTSTART;TZID=Europe/Warsaw:20261007T080000',
          'DTEND;TZID=Europe/Warsaw:20261007T090000',
          'STATUS:CANCELLED',
          'SUMMARY:Odwołane',
        ),
      ),
      WIDE,
    );
    expect(r.events.map((e) => [iso(e.startsAt), e.title, e.location])).toEqual([
      ['2026-10-06T08:00:00.000Z', 'Algorytmy', 'Sala A, 101'],
      ['2026-10-20T10:00:00.000Z', 'Algorytmy (zmiana sali)', 'Sala B 7'],
      ['2026-10-27T09:00:00.000Z', 'Algorytmy', 'Sala A, 101'],
    ]);
    expect(r.skipped).toBe(1);
  });

  it('zawijanie linii, znaki ucieczki, znaki sterujące; opis przycięty', () => {
    const r = parseIcs(
      ics(
        ...event(
          'UID:t',
          'DTSTART:20261005T080000Z',
          'DTEND:20261005T090000Z',
          'SUMMARY:Inżynieria\\, oprogramowania\\; wykład',
          ' (część 2)',
          `DESCRIPTION:Prowadzący: dr Jan Testowy\\nForma: wykład\u0007${'x'.repeat(600)}`,
        ),
      ),
      WIDE,
    );
    const e = r.events[0]!;
    expect(e.title).toBe('Inżynieria, oprogramowania; wykład(część 2)');
    expect(e.notes!.startsWith('Prowadzący: dr Jan Testowy; Forma: wykład')).toBe(true);
    expect(e.notes).not.toContain('\u0007');
    expect(e.notes!.length).toBe(500);
  });

  it('okno dat i limit liczby wydarzeń — reszta pominięta', () => {
    const r = parseIcs(
      ics(
        ...event(
          'UID:r',
          'DTSTART;TZID=Europe/Warsaw:20260105T080000',
          'DTEND;TZID=Europe/Warsaw:20260105T090000',
          'RRULE:FREQ=DAILY',
          'SUMMARY:Codziennie',
        ),
      ),
      {
        from: new Date('2026-10-01T00:00:00Z'),
        to: new Date('2026-10-11T00:00:00Z'),
        maxEvents: 5,
      },
    );
    expect(r.events).toHaveLength(5);
    expect(iso(r.events[0]!.startsAt)).toBe('2026-10-01T06:00:00.000Z');
    expect(r.skipped).toBeGreaterThan(200);
  });
});

describe('opis w liniach „Klucz: wartość” (Wirtualny Dziekanat IDEIS)', () => {
  it('sala z opisu jako miejsce; szczegóły zwięźle, bez powtórzeń i pustych pól', () => {
    // Układ jak w eksporcie IDEIS (ical.net): czas bez strefy, opis zawinięty; dane zmyślone.
    const r = parseIcs(
      ics(
        ...event(
          'DESCRIPTION:Plan dla toku: Ścieżka Testowa IS/TEST S inż. 2023/2024\\n\\n Data zaj',
          ' ęć: 2026.10.01 czwartek\\n Czas od: 16:00\\n Czas do: 17:30\\n Liczba godzin: ',
          ' 2h00m\\n Przedmiot: Systemy operacyjne \\n Forma zajęć: 1\\n Grupy: Konw\\n Sala: ',
          ' F Testowa \\n Prowadzący: dr Jan Testowy \\n Forma zaliczenia: Zaliczenie ocena\\n Uwagi: \\n',
          'DTEND:20261001T173000',
          'DTSTART:20261001T160000',
          'SUMMARY:Systemy operacyjne',
          'UID:ideis-1',
        ),
      ),
      WIDE,
    );
    expect(r.events).toEqual([
      {
        title: 'Systemy operacyjne',
        startsAt: new Date('2026-10-01T14:00:00Z'),
        endsAt: new Date('2026-10-01T15:30:00Z'),
        location: 'F Testowa',
        notes:
          'Forma zajęć: 1; Grupy: Konw; Prowadzący: dr Jan Testowy; Forma zaliczenia: Zaliczenie ocena',
      },
    ]);
  });

  it('LOCATION ma pierwszeństwo; opis bez pól zostaje bez zmian', () => {
    const r = parseIcs(
      ics(
        ...event(
          'UID:a',
          'DTSTART:20261005T080000Z',
          'LOCATION:Aula główna',
          'DESCRIPTION:Sala: F Inna\\nProwadzący: dr Anna Przykładowa',
          'SUMMARY:A',
        ),
        ...event('UID:b', 'DTSTART:20261005T090000Z', 'DESCRIPTION:Przynieś laptopa.', 'SUMMARY:B'),
      ),
      WIDE,
    );
    expect(r.events.map((e) => [e.title, e.location, e.notes])).toEqual([
      ['A', 'Aula główna', 'Prowadzący: dr Anna Przykładowa'],
      ['B', null, 'Przynieś laptopa.'],
    ]);
  });
});

describe('błędne pliki', () => {
  it('nie kalendarz albo uszkodzony => czytelny błąd; pusty kalendarz => brak wydarzeń', () => {
    expect(() => parseIcs('Czas od;Czas do;Zajecia', WIDE)).toThrow(IcsError);
    expect(() => parseIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:bzdura', WIDE)).toThrow(
      /uszkodzony|kalendarza/,
    );
    expect(parseIcs(ics(), WIDE)).toEqual({ events: [], skipped: 0 });
    // Znak BOM na początku (częsty w plikach z Windows) nie przeszkadza.
    const bom = `\uFEFF${ics(...event('UID:b', 'DTSTART:20261005T080000Z', 'SUMMARY:Z BOM'))}`;
    expect(parseIcs(bom, WIDE).events.map((e) => e.title)).toEqual(['Z BOM']);
  });
});
