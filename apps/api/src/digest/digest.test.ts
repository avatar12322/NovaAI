import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { wallClockToUtc } from '../calendar/ics';
import { seedDev } from '../db/seed';
import { createTestApp, login, truncateAll, type Client, type TestApp } from '../test/helpers';
import { runDueDigests, TZ, warsawClock } from './service';

/** Przeglądy dnia: rano (dziś) i wieczorem (jutro), raz dziennie, pogoda z atrapy Open-Meteo. */
let t: TestApp;
let alfa: Client;
let beta: Client;
let server: Server;
const weatherCalls: string[] = [];

/** Dzień D = pojutrze (czas polski) — przypomnienia na D są w przyszłości względem prawdziwego „teraz”. */
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const today = warsawClock(new Date()).date;
const D = addDays(today, 2);
const at = (date: string, h: number, m: number) => {
  const [y, mo, d] = date.split('-').map(Number);
  return wallClockToUtc(y!, mo!, d!, h, m, 0, TZ);
};

beforeAll(async () => {
  server = createServer((req, res) => {
    weatherCalls.push(req.url ?? '');
    const u = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/v1/search') {
      const name = u.searchParams.get('name');
      res.end(
        JSON.stringify(
          name === 'Nigdzie'
            ? {}
            : {
                results: [
                  {
                    name: 'Kraków',
                    latitude: 50.06,
                    longitude: 19.94,
                    admin1: 'Małopolskie',
                    country: 'Polska',
                  },
                ],
              },
        ),
      );
      return;
    }
    const time = [0, 1, 2, 3, 4].map((i) => addDays(today, i));
    res.end(
      JSON.stringify({
        daily: {
          time,
          weather_code: [0, 3, 63, 71, 95],
          temperature_2m_max: [20, 18, 14.4, 2, 25],
          temperature_2m_min: [10, 9, 8.6, -3, 15],
          precipitation_probability_max: [0, 10, 70, 90, 80],
        },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t = await createTestApp({}, { weatherBases: { forecast: base, geocoding: base } });
});
afterAll(async () => {
  await t.close();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(async () => {
  await truncateAll(t.db);
  t.seed = await seedDev(t.db, 'test');
  alfa = await login(t.app, 'alfa');
  beta = await login(t.app, 'beta');
});

async function briefings(userId: string) {
  return (
    await t.db.owner.query<{ title: string; body: string }>(
      `SELECT title, body FROM notifications WHERE user_id = $1 AND kind = 'briefing' ORDER BY created_at`,
      [userId],
    )
  ).rows;
}

describe('przeglądy dnia', () => {
  it('wieczorem „jutro”, rano „dziś”: zajęcia z salą, przypomnienia, pogoda — raz dziennie', async () => {
    expect((await beta.put('/api/household/weather', { place: 'Kraków' })).status).toBe(403);
    const w = await alfa.put('/api/household/weather', { place: 'Kraków' });
    expect(w.status).toBe(200);
    expect(w.body.weatherPlace).toBe('Kraków, Małopolskie, Polska');
    expect((await alfa.put('/api/household/weather', { place: 'Nigdzie' })).status).toBe(400);

    await t.db.owner.query(
      `INSERT INTO local_calendar_events (household_id, owner_user_id, title, starts_at, ends_at, location)
       VALUES ($1, $2, 'Analiza danych', $3, $4, 'F Los Angeles')`,
      [t.seed.householdId, t.seed.users.alfa, at(D, 8, 0), at(D, 9, 30)],
    );
    await alfa.post('/api/reminders', { text: 'Oddać projekt', dueAt: at(D, 9, 0).toISOString() });
    await beta.post('/api/reminders', {
      text: 'Zakupy na weekend',
      dueAt: at(D, 18, 0).toISOString(),
      space: 'shared',
    });
    await beta.post('/api/reminders', { text: 'Prywatne Bety', dueAt: at(D, 12, 0).toISOString() });

    // 22:05 dzień wcześniej — przegląd „jutro”.
    expect(await runDueDigests(t.deps, at(addDays(D, -1), 22, 5))).toBe(2);
    const [a] = await briefings(t.seed.users.alfa);
    expect(a!.title).toMatch(/^Jutro: /);
    expect(a!.body.split('\n')).toEqual([
      '08:00 Analiza danych (sala: F Los Angeles)',
      'Przypomnienie 09:00: Oddać projekt',
      'Przypomnienie 18:00: Zakupy na weekend (wspólne)',
      'Pogoda: 9–14°C, deszcz, szansa opadów 70%',
    ]);
    const [b] = await briefings(t.seed.users.beta);
    expect(b!.body).toContain('Prywatne Bety');
    expect(b!.body).not.toContain('Analiza danych');
    expect(b!.body).not.toContain('Oddać projekt');
    // Raz dziennie — także przy kolejnym sprawdzeniu w oknie.
    expect(await runDueDigests(t.deps, at(addDays(D, -1), 22, 30))).toBe(0);

    // 7:10 w dniu D — „dziś”; pogoda z bufora (bez ponownego zapytania).
    const calls = weatherCalls.length;
    expect(await runDueDigests(t.deps, at(D, 7, 10))).toBe(2);
    const morning = (await briefings(t.seed.users.alfa))[1]!;
    expect(morning.title).toMatch(/^Dzień dobry, Alfa — dziś /);
    expect(morning.body).toContain('08:00 Analiza danych');
    expect(weatherCalls.length).toBe(calls);
  });

  it('ustawienia osoby: wyłączony przegląd, inna godzina; spóźniony przegląd pominięty', async () => {
    expect((await beta.get('/api/digest/settings')).body).toMatchObject({
      morning: true,
      morningAt: '07:00',
      evening: true,
      eveningAt: '22:00',
      weatherPlace: null,
      canSetWeather: false,
    });
    expect(
      (
        await beta.put('/api/digest/settings', {
          morning: true,
          morningAt: '06:30',
          evening: false,
          eveningAt: '22:00',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await beta.put('/api/digest/settings', {
          morning: true,
          morningAt: '25:00',
          evening: false,
          eveningAt: '22:00',
        })
      ).status,
    ).toBe(400);

    expect(await runDueDigests(t.deps, at(addDays(D, -1), 22, 1))).toBe(1); // tylko Alfa
    expect(await briefings(t.seed.users.beta)).toEqual([]);
    expect(await runDueDigests(t.deps, at(D, 6, 35))).toBe(1); // Beta o 6:30, Alfa jeszcze nie
    expect(await runDueDigests(t.deps, at(D, 8, 40))).toBe(0); // Alfa: ponad 90 min po 7:00
    expect(await briefings(t.seed.users.alfa)).toHaveLength(1);

    // Bez miejsca pogody przegląd idzie bez pogody.
    const [beta1] = await briefings(t.seed.users.beta);
    expect(beta1!.body).toBe('Nic w planie na dziś.');
  });

  it('podgląd treści bez wysyłki', async () => {
    const p = await alfa.get('/api/digest/preview?kind=evening');
    expect(p.status).toBe(200);
    expect(p.body.title).toMatch(/^Jutro: /);
    expect(await briefings(t.seed.users.alfa)).toEqual([]);
  });
});
