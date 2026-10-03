import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDev } from '../db/seed';
import { ModelsConfigSchema } from '../model/config';
import { FakeProvider } from '../model/providers/fake';
import type { ProviderResponse } from '../model/types';
import { createTestApp, login, truncateAll, type Client, type TestApp } from '../test/helpers';

/**
 * Plan zajęć z pliku .ics: wgranie, przegląd dnia z salą, podmiana nowym plikiem, usunięcie, izolacja między
 * domownikami, błędne pliki i odczyt przez prywatnego asystenta (model = atrapa dostawcy). Dane zmyślone.
 */
const day = (offset: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' })
    .format(new Date(Date.now() + offset * 86_400_000))
    .replaceAll('-', '');
const vevent = (
  uid: string,
  date: string,
  from: string,
  to: string,
  title: string,
  room: string,
) => [
  'BEGIN:VEVENT',
  `UID:${uid}`,
  `DTSTART;TZID=Europe/Warsaw:${date}T${from}00`,
  `DTEND;TZID=Europe/Warsaw:${date}T${to}00`,
  `SUMMARY:${title}`,
  `LOCATION:${room}`,
  'DESCRIPTION:Prowadzący: dr Jan Testowy',
  'END:VEVENT',
];
const calendar = (...events: string[][]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:test', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
const PLAN = calendar(
  vevent('1', day(0), '0800', '0930', 'Programowanie obiektowe', 'A-101'),
  vevent('2', day(1), '1000', '1130', 'Bazy danych', 'B-7'),
);

let t: TestApp;
let alfa: Client;
let beta: Client;
const send = (c: Client, body: string, opts: { id?: string; name?: string; csrf?: boolean } = {}) =>
  t.app.inject({
    method: opts.id ? 'PUT' : 'POST',
    url: `/api/calendar/imports${opts.id ? `/${opts.id}` : ''}${opts.name ? `?name=${encodeURIComponent(opts.name)}` : ''}`,
    headers: {
      cookie: c.cookie,
      'content-type': 'text/calendar',
      ...(opts.csrf === false ? {} : { 'x-nova-csrf': '1' }),
    },
    payload: body,
  });

describe('plan zajęć z pliku .ics', () => {
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());
  beforeEach(async () => {
    await truncateAll(t.db);
    t.seed = await seedDev(t.db, 'test');
    alfa = await login(t.app, 'alfa');
    beta = await login(t.app, 'beta');
  });

  it('wgranie: lista importów, przegląd dnia z salą, bez zalewania listy wydarzeń; audyt bez tytułów', async () => {
    const res = await send(alfa, PLAN, { name: 'Plan WSEI' });
    expect(res.statusCode).toBe(201);
    const imp = res.json().import;
    expect(imp).toMatchObject({ name: 'Plan WSEI', eventCount: 2 });
    expect(imp.nextAt).not.toBeNull();
    expect((await alfa.get('/api/calendar/imports')).body.items).toHaveLength(1);

    const b = (await alfa.get('/api/briefing')).body;
    expect(b.events).toEqual([
      expect.objectContaining({ title: 'Programowanie obiektowe', location: 'A-101' }),
    ]);
    expect(b.summary).toMatch(/W kalendarzu: \d\d:\d\d Programowanie obiektowe \(A-101\)\./);
    // Ręczna lista wydarzeń nie pokazuje zajęć z importu.
    expect((await alfa.get('/api/calendar/local-events')).body.items).toEqual([]);

    const audit = await t.db.owner.query(
      `SELECT action, details::text AS d FROM audit_log WHERE action LIKE 'calendar.import%'`,
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['calendar.import']);
    expect(audit.rows[0].d).not.toContain('Programowanie');
  });

  it('nowa wersja planu zastępuje stare zajęcia; usunięcie usuwa wszystkie', async () => {
    const id = (await send(alfa, PLAN)).json().import.id;
    const next = calendar(vevent('3', day(2), '1200', '1330', 'Sieci komputerowe', 'C-3'));
    const upd = await send(alfa, next, { id });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().import).toMatchObject({ id, name: 'Plan zajęć', eventCount: 1 });
    const titles = await t.db.owner.query(`SELECT title FROM local_calendar_events`);
    expect(titles.rows.map((r) => r.title)).toEqual(['Sieci komputerowe']);

    const del = await t.app.inject({
      method: 'DELETE',
      url: `/api/calendar/imports/${id}`,
      headers: { cookie: alfa.cookie, 'x-nova-csrf': '1' },
    });
    expect(del.statusCode).toBe(204);
    expect((await t.db.owner.query(`SELECT 1 FROM local_calendar_events`)).rows).toHaveLength(0);
    expect((await alfa.get('/api/calendar/imports')).body.items).toEqual([]);
  });

  it('Beta nie widzi ani nie zmienia planu Alfy', async () => {
    const id = (await send(alfa, PLAN)).json().import.id;
    expect((await beta.get('/api/calendar/imports')).body.items).toEqual([]);
    expect((await beta.get('/api/briefing')).body.events).toEqual([]);
    expect((await send(beta, PLAN, { id })).statusCode).toBe(404);
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/api/calendar/imports/${id}`,
      headers: { cookie: beta.cookie, 'x-nova-csrf': '1' },
    });
    expect(del.statusCode).toBe(404);
    expect((await t.db.owner.query(`SELECT 1 FROM local_calendar_events`)).rows).toHaveLength(2);
  });

  it('wybór przedmiotów: odznaczony znika z przeglądu dnia; wybór zostaje w nowej wersji planu', async () => {
    const id = (await send(alfa, PLAN)).json().import.id;
    const patch = (excluded: string[], c: Client = alfa) =>
      t.app.inject({
        method: 'PATCH',
        url: `/api/calendar/imports/${id}`,
        headers: { cookie: c.cookie, 'x-nova-csrf': '1' },
        payload: { excluded },
      });
    const res = await patch(['Programowanie obiektowe']);
    expect(res.statusCode).toBe(200);
    expect(res.json().import).toMatchObject({
      eventCount: 2,
      visibleCount: 1,
      subjects: [
        { title: 'Bazy danych', count: 1, hidden: false },
        { title: 'Programowanie obiektowe', count: 1, hidden: true },
      ],
    });
    expect((await alfa.get('/api/briefing')).body.events).toEqual([]);

    // Nowa wersja z tym samym przedmiotem: nadal ukryty.
    const next = calendar(
      vevent('9', day(0), '1200', '1330', 'Programowanie obiektowe', 'A-101'),
      vevent('10', day(0), '1400', '1530', 'Sieci komputerowe', 'C-3'),
    );
    await send(alfa, next, { id });
    const b = (await alfa.get('/api/briefing')).body;
    expect(b.events.map((e: any) => e.title)).toEqual(['Sieci komputerowe']);

    // Ponowne zaznaczenie; Beta nie zmienia planu Alfy.
    expect((await patch([], beta)).statusCode).toBe(404);
    await patch([]);
    expect((await alfa.get('/api/briefing')).body.events).toHaveLength(2);
    expect((await patch(['x'.repeat(201)])).statusCode).toBe(400);
  });

  it('plan wgrany przed odczytem sali: sala z zapisanego opisu, bez ponownego wgrywania', async () => {
    const id = (await send(alfa, PLAN)).json().import.id;
    // Stan sprzed poprawki: pusta sala, pełny opis z IDEIS w notatkach (dane zmyślone).
    await t.db.owner.query(
      `UPDATE local_calendar_events SET location = NULL,
         notes = E'Plan dla toku: Tok testowy\\n\\n Data zajęć: 2026.10.01\\n Sala: F Testowa \\n Prowadzący: dr Jan Testowy \\n Uwagi: \\n'
       WHERE import_id = $1`,
      [id],
    );
    const b = (await alfa.get('/api/briefing')).body;
    expect(b.events[0]).toMatchObject({ title: 'Programowanie obiektowe', location: 'F Testowa' });
  });

  it('błędne pliki: nie kalendarz, pusty plan (z instrukcją), za duży, bez logowania i CSRF', async () => {
    const notIcs = await send(alfa, 'Czas od;Czas do;Zajecia');
    expect(notIcs.statusCode).toBe(400);
    expect(notIcs.json().error.message).toBe('To nie jest plik kalendarza (.ics)');
    const empty = await send(alfa, calendar());
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.message).toContain('kliknij „Szukaj”, a potem „Zapisz jako ical”');
    expect((await send(alfa, 'x'.repeat(2 * 1024 * 1024 + 1))).statusCode).toBe(413);
    expect((await send(alfa, PLAN, { csrf: false })).statusCode).toBe(403);
    const anon = await t.app.inject({
      method: 'POST',
      url: '/api/calendar/imports',
      headers: { 'content-type': 'text/calendar', 'x-nova-csrf': '1' },
      payload: PLAN,
    });
    expect(anon.statusCode).toBe(401);
    expect((await alfa.get('/api/calendar/imports')).body.items).toEqual([]);
  });
});

describe('asystent czyta plan zajęć (calendar.agenda)', () => {
  let toolCalls: ProviderResponse['toolCalls'] = [];
  const provider = new FakeProvider({
    text: () => 'Jutro masz Bazy danych.',
    get toolCalls() {
      return toolCalls;
    },
  });
  const modelsConfig = ModelsConfigSchema.parse({
    currency: 'PLN',
    providers: { llm: { kind: 'fake' } },
    models: {
      main: {
        provider: 'llm',
        model: 'test-model',
        maxTokens: 1000,
        pricing: { currency: 'PLN', inputPerMTok: 1, outputPerMTok: 1, verifiedAt: '2026-09-25' },
      },
    },
    routes: { 'chat.simple': ['main'], 'chat.complex': ['main'] },
  });
  beforeAll(async () => {
    t = await createTestApp({}, { modelsConfig, providerOverrides: { llm: provider } });
  });
  afterAll(async () => t.close());
  beforeEach(async () => {
    await truncateAll(t.db);
    t.seed = await seedDev(t.db, 'test');
    alfa = await login(t.app, 'alfa');
    beta = await login(t.app, 'beta');
    provider.calls = [];
    toolCalls = [];
  });
  const ask = async (c: Client, space: 'private' | 'shared', content: string) => {
    const conv = (await c.post('/api/conversations', { space })).body;
    await c.post(`/api/conversations/${conv.id}/messages`, { content });
    await t.drain();
    return (await c.get(`/api/conversations/${conv.id}/messages`)).body.items as Array<{
      role: string;
      content: string;
    }>;
  };
  const range = {
    from: new Date(Date.now() - 86_400_000).toISOString(),
    to: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  };

  it('prywatny asystent: zna dzisiejszą datę, dostaje narzędzie, wynik trafia do modelu bez zgody', async () => {
    await send(alfa, PLAN);
    toolCalls = [{ name: 'calendar.agenda', input: range }];
    const msgs = await ask(alfa, 'private', 'co mam jutro na uczelni?');
    const [first, second] = provider.calls;
    // Godzina na początku ostatniej wiadomości — prompt systemowy bez zmiennych danych (pamięć podręczna).
    expect(first!.messages.at(-1)!.content).toMatch(
      /^TERAZ: \S+, \d{1,2} \S+ \d{4} \d\d:\d\d \(czas w Polsce\)/,
    );
    expect(first!.system).not.toContain('(czas w Polsce)');
    expect(first!.tools.map((x) => x.name)).toContain('calendar.agenda');
    const fed = JSON.stringify(second!.messages);
    expect(fed).toContain(
      'Programowanie obiektowe — sala/miejsce: A-101 (Prowadzący: dr Jan Testowy)',
    );
    expect(fed).toContain('Bazy danych — sala/miejsce: B-7');
    // Wynik (z listą zajęć) zostaje w prywatnej rozmowie właściciela.
    expect(msgs.find((m) => m.role === 'tool')!.content).toMatch(
      /^Kalendarz NovaAI: 2 wydarzenia\n.*Programowanie obiektowe — sala\/miejsce: A-101/s,
    );
    expect(msgs.at(-1)).toMatchObject({ role: 'assistant', content: 'Jutro masz Bazy danych.' });
    const approvals = await t.db.owner.query('SELECT count(*)::int AS n FROM approvals');
    expect(approvals.rows[0].n).toBe(0);
  });

  it('NovaAI (wspólny) nie ma narzędzia; Beta widzi tylko własny kalendarz', async () => {
    await send(alfa, PLAN);
    await ask(alfa, 'shared', 'co mamy w planie?');
    expect(provider.calls[0]!.tools.map((x) => x.name)).not.toContain('calendar.agenda');

    provider.calls = [];
    toolCalls = [{ name: 'calendar.agenda', input: range }];
    await ask(beta, 'private', 'co mam jutro?');
    const fed = JSON.stringify(provider.calls[1]!.messages);
    expect(fed).not.toContain('Programowanie obiektowe');
    expect(fed).not.toContain('A-101');
  });
});
