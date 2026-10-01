import { Timetable } from './gtfs';
import { connectionsOn, type Connections } from './router';
import { readZip } from './zip';

/**
 * Źródła rozkładów: pociągi wszystkich przewoźników (PKP PLK „Otwarte Dane Kolejowe” w formacie GTFS,
 * mkuran.pl — aktualizowane codziennie, z danymi na żywo) i autobusy Kolei Małopolskich (GTFS przewoźnika).
 * Pobierane przy pierwszym pytaniu i odświeżane raz na dobę; opóźnienia — najwyżej sprzed 2 minut.
 */
export interface FeedSource {
  prefix: string;
  url: string;
}

export const TRANSIT_FEEDS: FeedSource[] = [
  { prefix: 'T:', url: 'https://mkuran.pl/gtfs/polish_trains.zip' },
  { prefix: 'B:', url: 'https://www.kolejemalopolskie.com.pl/rozklady_jazdy/ald-gtfs.zip' },
];
export const TRANSIT_REALTIME = 'https://mkuran.pl/gtfs/polish_trains/updates.json';
/** Przedrostek źródła, którego dotyczą dane na żywo. */
export const REALTIME_FEED = 'T:';

const FILES = [
  'feed_info.txt',
  'agency.txt',
  'routes.txt',
  'stops.txt',
  'trips.txt',
  'stop_times.txt',
  'calendar.txt',
  'calendar_dates.txt',
];
const MAX_BYTES = 150 * 1024 * 1024;
const REFRESH_MS = 20 * 3600_000;
const LIVE_MS = 2 * 60_000;

export interface LiveStop {
  arr?: number;
  dep?: number;
  cancelled?: boolean;
}
/** Dane na żywo: `${trip_id}|RRRR-MM-DD` → przystanki kursu wg stop_sequence. */
export type Live = Map<string, { cancelled: boolean; stops: Map<number, LiveStop> }>;

async function download(url: string, timeoutMs: number): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'NovaAI (asystent domowy)' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BYTES) throw new Error(`${new URL(url).host}: plik za duży`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`${new URL(url).host}: plik za duży`);
  return buf;
}

export class TransitSource {
  private table: Timetable | null = null;
  private loading: Promise<Timetable> | null = null;
  private readonly days = new Map<string, Connections>();
  private live: { at: number; data: Live | null } | null = null;

  constructor(
    private readonly feeds: readonly FeedSource[] = TRANSIT_FEEDS,
    private readonly realtimeUrl: string | null = TRANSIT_REALTIME,
  ) {}

  /** Rozkład (pobrany najwyżej 20 h temu); przy błędzie odświeżenia — poprzedni. */
  async timetable(): Promise<Timetable> {
    const fresh = this.table && Date.now() - this.table.loadedAt.getTime() < REFRESH_MS;
    if (fresh) return this.table!;
    this.loading ??= Promise.all(
      this.feeds.map(async (f) => ({
        prefix: f.prefix,
        files: readZip(await download(f.url, 120_000), FILES),
      })),
    )
      .then((feeds) => {
        this.table = new Timetable(feeds);
        this.days.clear();
        return this.table;
      })
      .finally(() => {
        this.loading = null;
      });
    try {
      return await this.loading;
    } catch (err) {
      if (this.table) return this.table;
      throw err;
    }
  }

  /** Odcinki kursów w danym dniu (RRRRMMDD) — liczone raz na dzień i rozkład. */
  async connections(date: string): Promise<{ tt: Timetable; c: Connections }> {
    const tt = await this.timetable();
    let c = this.days.get(date);
    if (!c) {
      c = connectionsOn(tt, date);
      if (this.days.size >= 3) this.days.delete(this.days.keys().next().value!);
      this.days.set(date, c);
    }
    return { tt, c };
  }

  /** Opóźnienia i odwołania pociągów (null — chwilowo niedostępne; wtedy sam rozkład). */
  async realtime(): Promise<Live | null> {
    if (!this.realtimeUrl) return null;
    if (this.live && Date.now() - this.live.at < LIVE_MS) return this.live.data;
    let data: Live | null;
    try {
      const json = JSON.parse((await download(this.realtimeUrl, 30_000)).toString('utf8')) as {
        trip_updates?: Array<{
          trip_id: string;
          start_date: string;
          cancelled?: boolean;
          stop_times?: Array<{
            stop_sequence: number;
            arrival?: string;
            departure?: string;
            cancelled?: boolean;
          }> | null;
        }> | null;
      };
      data = new Map();
      for (const u of json.trip_updates ?? []) {
        const stops = new Map<number, LiveStop>();
        for (const s of u.stop_times ?? [])
          stops.set(s.stop_sequence, {
            ...(s.arrival ? { arr: Date.parse(s.arrival) } : {}),
            ...(s.departure ? { dep: Date.parse(s.departure) } : {}),
            ...(s.cancelled ? { cancelled: true } : {}),
          });
        data.set(`${u.trip_id}|${u.start_date}`, { cancelled: u.cancelled === true, stops });
      }
    } catch {
      data = null;
    }
    this.live = { at: Date.now(), data };
    return data;
  }
}
