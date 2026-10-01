import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { wallClockToUtc } from '../calendar/ics';
import { seedDev } from '../db/seed';
import { warsawClock } from '../digest/service';
import { ModelsConfigSchema } from '../model/config';
import { FakeProvider } from '../model/providers/fake';
import type { ProviderResponse } from '../model/types';
import { createTestApp, login, truncateAll, type Client, type TestApp } from '../test/helpers';
import { Timetable } from './gtfs';
import { connectionsOn, journeys, resolveStops } from './router';
import { readZip } from './zip';

/**
 * Połączenia z rozkładów GTFS (atrapa: pociągi + autobusy): przesiadka, przejście piesze z dworca
 * autobusowego, kalendarz (kurs odwołany w danym dniu), „przyjazd do”, opóźnienie na żywo, asystent.
 */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(n.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    central.push(dir, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const today = warsawClock(new Date()).date;
const ymd = today.replace(/-/g, '');
const TRAINS = {
  'agency.txt': 'agency_id,agency_name\nPR,PolRegio',
  'routes.txt': 'route_id,agency_id,route_short_name,route_type\nR,PR,K52,2',
  'stops.txt': [
    'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station',
    'A,Andrychów,49.85582,19.35330,1,',
    'A_1,Andrychów,49.85582,19.35330,0,A',
    'X,Kalwaria Zebrzydowska Lanckorona,49.86,19.68,1,',
    'K,Kraków Główny,50.0686,19.9478,1,',
  ].join('\n'),
  'trips.txt': [
    'route_id,service_id,trip_id,trip_short_name,trip_headsign',
    'R,S1,T1,43140,Kraków Główny',
    'R,S1,T3,43150,Kraków Główny',
    'R,S1,T2,43142 Skawa,Kraków Główny',
    'R,S2,TX,49999,Kraków Główny',
  ].join('\n'),
  'calendar.txt':
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nS2,1,1,1,1,1,1,1,20200101,20991231',
  'calendar_dates.txt': `service_id,date,exception_type\nS1,${ymd},1\nS2,${ymd},2`,
  'stop_times.txt': [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence,platform,track',
    'T1,06:00:00,06:00:00,A_1,0,1,2',
    'T1,06:40:00,06:41:00,X,1,,',
    'T1,07:30:00,07:30:00,K,2,,',
    'T3,06:50:00,06:50:00,X,0,,',
    'T3,07:20:00,07:20:00,K,1,,',
    'T2,07:00:00,07:00:00,A_1,0,1,2',
    'T2,08:30:00,08:30:00,K,1,,',
    'TX,06:10:00,06:10:00,A_1,0,,',
    'TX,06:50:00,06:50:00,K,1,,',
  ].join('\n'),
};
const BUSES = {
  'agency.txt': 'agency_id,agency_name\n246,Koleje Małopolskie',
  'routes.txt': 'route_id,agency_id,route_short_name,route_type\nA40,246,A40,3',
  'stops.txt': [
    'stop_id,stop_name,stop_lat,stop_lon',
    'D,Andrychów Dworzec Autobusowy,49.8575,19.3540',
    'M,Kraków MDA,50.06833,19.949039',
  ].join('\n'),
  'trips.txt': 'route_id,service_id,trip_id,trip_headsign\nA40,W,B1,Kraków MDA',
  'calendar.txt':
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nW,1,1,1,1,1,1,1,20200101,20991231',
  'stop_times.txt': [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'B1,06:30:00,06:30:00,D,0',
    'B1,07:10:00,07:10:00,M,1',
  ].join('\n'),
};
const [y, m, d] = today.split('-').map(Number);
const LIVE = JSON.stringify({
  timestamp: new Date().toISOString(),
  trip_updates: [
    {
      id: 'u1',
      trip_id: 'T2',
      start_date: today,
      stop_times: [
        {
          stop_sequence: 0,
          departure: wallClockToUtc(y!, m!, d!, 7, 6, 0, 'Europe/Warsaw').toISOString(),
        },
      ],
    },
  ],
});

const feed = (prefix: string, files: Record<string, string>) => ({
  prefix,
  files: readZip(zip(files), Object.keys(files)),
});

describe('rozkłady i wyszukiwanie połączeń', () => {
  const tt = new Timetable([feed('T:', TRAINS), feed('B:', BUSES)]);
  const c = connectionsOn(tt, ymd);
  const from = resolveStops(tt, 'andrychow', 'from');
  const to = resolveStops(tt, 'Kraków', 'to');

  it('nazwy: bez polskich znaków, miasto → stacja główna albo przystanki w mieście', () => {
    expect(from.names).toEqual(['Andrychów', 'Andrychów Dworzec Autobusowy']);
    expect(to.names).toEqual(['Kraków Główny']);
    expect(resolveStops(tt, 'Kalwaria', 'to').names).toEqual(['Kalwaria Zebrzydowska Lanckorona']);
    expect(resolveStops(tt, 'Gdańsk', 'to').ids).toEqual([]);
  });

  it('odjazd: autobus + dojście z MDA wygrywa z przesiadką; kurs odwołany w tym dniu pominięty', () => {
    const list = journeys(tt, c, from.ids, to.ids, { t0: 5 * 3600 + 50 * 60, count: 3 });
    expect(list.map((j) => [j.dep, Math.floor(j.arr / 60)])).toEqual([
      [6 * 3600 + 30 * 60, 7 * 60 + 12],
      [7 * 3600, 8 * 60 + 30],
    ]);
    expect(list[0]!.legs.map((l) => l.kind)).toEqual(['ride', 'walk']);
    // Same pociągi: przesiadka w Kalwarii (4 min wystarczą: 06:40 → 06:50).
    const rail = new Timetable([feed('T:', TRAINS)]);
    const trains = journeys(
      rail,
      connectionsOn(rail, ymd),
      resolveStops(rail, 'Andrychów', 'from').ids,
      resolveStops(rail, 'Kraków', 'to').ids,
      { t0: 5 * 3600 + 50 * 60, count: 1 },
    );
    expect(trains[0]!.legs.map((l) => rail.trips[l.trip!]!.id)).toEqual(['T1', 'T3']);
    expect(trains[0]!.arr).toBe(7 * 3600 + 20 * 60);
  });

  it('przyjazd do 08:00: tylko połączenia, które zdążą', () => {
    const list = journeys(tt, c, from.ids, to.ids, { t0: 0, count: 3, deadline: 8 * 3600 });
    expect(list.map((j) => j.dep)).toEqual([6 * 3600 + 30 * 60]);
  });
});

describe('asystent: transit.search', () => {
  let site: Server;
  let t: TestApp;
  let alfa: Client;
  let script: Array<ProviderResponse['toolCalls']> = [];
  const provider: FakeProvider = new FakeProvider({
    text: () => 'Gotowe.',
    get toolCalls(): ProviderResponse['toolCalls'] {
      return script[provider.calls.length - 1] ?? [];
    },
  });

  beforeAll(async () => {
    const files: Record<string, Buffer | string> = {
      '/t.zip': zip(TRAINS),
      '/b.zip': zip(BUSES),
      '/rt.json': LIVE,
    };
    site = createServer((req, res) => {
      const body = files[req.url ?? ''];
      res.statusCode = body ? 200 : 404;
      res.end(body ?? '');
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    t = await createTestApp(
      {},
      {
        modelsConfig: ModelsConfigSchema.parse({
          currency: 'PLN',
          providers: { llm: { kind: 'fake' } },
          models: {
            main: {
              provider: 'llm',
              model: 'test-model',
              maxTokens: 1000,
              pricing: {
                currency: 'PLN',
                inputPerMTok: 10,
                outputPerMTok: 20,
                verifiedAt: '2026-09-25',
              },
            },
          },
          routes: { 'chat.simple': ['main'], 'chat.complex': ['main'] },
        }),
        providerOverrides: { llm: provider },
        transitFeeds: [
          { prefix: 'T:', url: `${base}/t.zip` },
          { prefix: 'B:', url: `${base}/b.zip` },
        ],
        transitRealtime: `${base}/rt.json`,
      },
    );
  });
  afterAll(async () => {
    await t.close();
    site.close();
  });
  beforeEach(async () => {
    await truncateAll(t.db);
    t.seed = await seedDev(t.db, 'test');
    alfa = await login(t.app, 'alfa');
    provider.calls = [];
  });

  async function ask(input: Record<string, unknown>) {
    script = [[{ name: 'transit.search', input }]];
    const conv = (await alfa.post('/api/conversations', { space: 'private' })).body;
    await alfa.post(`/api/conversations/${conv.id}/messages`, {
      content: 'jak dojadę do Krakowa?',
    });
    await t.drain();
    const msgs = (await alfa.get(`/api/conversations/${conv.id}/messages`)).body.items;
    return msgs.find((x: { role: string }) => x.role === 'tool').content as string;
  }

  it('połączenia z godzinami, peronem, dojściem i opóźnieniem na żywo; w kolejnej turze — dla modelu', async () => {
    const out = await ask({ from: 'Andrychów', to: 'Kraków', time: '05:50', count: 2 });
    expect(out).toContain('Andrychów / Andrychów Dworzec Autobusowy → Kraków Główny');
    expect(out).toMatch(/1\) 06:30 → 07:12 \(42 min, bez przesiadek\)/);
    expect(out).toContain(
      'autobus Koleje Małopolskie A40 (kierunek Kraków MDA): Andrychów Dworzec Autobusowy 06:30 → Kraków MDA 07:10',
    );
    expect(out).toMatch(/pieszo \d min: Kraków MDA → Kraków Główny/);
    expect(out).toContain(
      'pociąg PolRegio K52 43142 Skawa (kierunek Kraków Główny): Andrychów 07:00 (peron 1, tor 2) [opóźnienie +6 min] → Kraków Główny 08:30',
    );
    expect(out).toContain('opóźnienia pociągów na żywo');
    expect(out).not.toContain('49999');
    // Wynik trafia do tury uzupełniającej modelu.
    expect(JSON.stringify(provider.calls[1]!.messages)).toContain('Kraków MDA');
  });

  it('nieznana nazwa — podpowiedzi zamiast zgadywania', async () => {
    const out = await ask({ from: 'Andrychow', to: 'Kalwarja' });
    expect(out).toContain('Nie znam przystanku „Kalwarja”');
  });
});
