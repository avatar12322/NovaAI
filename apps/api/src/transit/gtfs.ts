/**
 * Rozkład jazdy w pamięci z plików GTFS (kilka źródeł naraz: pociągi + autobusy). Przystanki z peronami
 * łączone w stację (parent_station), przesiadki piesze między pobliskimi przystankami (np. Kraków MDA ↔
 * Kraków Główny), kursy z kalendarzem dni kursowania. Czasy w sekundach od północy dnia kursu (mogą być
 * ≥ 24 h — kurs po północy).
 */
export interface FeedFiles {
  /** Przedrostek identyfikatorów (unikalny między źródłami). */
  prefix: string;
  files: Map<string, Buffer>;
}

export type Mode = 'train' | 'bus' | 'other';

export interface Stop {
  name: string;
  norm: string;
  lat: number;
  lon: number;
}

export interface Trip {
  /** Identyfikator kursu w źródle (bez przedrostka) — do danych na żywo. */
  id: string;
  feed: string;
  service: string;
  mode: Mode;
  label: string;
  headsign: string;
  /** Zakres w tablicach przystanków kursu (st*). */
  start: number;
  len: number;
}

const NO_PICKUP = 1;
const NO_DROPOFF = 2;
const WALK_RADIUS_M = 450;
const WALK_SPEED_MS = 1.2;
const WALK_DETOUR = 1.3;
const WALK_BUFFER_S = 60;

/** Wiersze CSV z bufora — bez zamiany całego pliku na napis (stop_times ma dziesiątki MB). */
export function* csvRows(buf: Buffer): Generator<string[]> {
  let start = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  while (start < buf.length) {
    let end = buf.indexOf(10, start);
    if (end < 0) end = buf.length;
    let line = buf.toString('utf8', start, end);
    start = end + 1;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line) continue;
    if (!line.includes('"')) {
      yield line.split(',');
      continue;
    }
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    yield out;
  }
}

/** Tabela jako obiekty z nagłówka (małe pliki); brak pliku — pusta lista. */
function table(f: FeedFiles, name: string): Array<Record<string, string>> {
  const buf = f.files.get(name);
  if (!buf) return [];
  const it = csvRows(buf);
  const head = it.next().value as string[] | undefined;
  if (!head) return [];
  const out: Array<Record<string, string>> = [];
  for (const row of it) {
    const o: Record<string, string> = {};
    head.forEach((h, i) => (o[h.trim()] = row[i] ?? ''));
    out.push(o);
  }
  return out;
}

export function normName(s: string): string {
  return s
    .toLocaleLowerCase('pl-PL')
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const secs = (t: string): number => {
  const [h, m, s] = t.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s ?? 0);
};

const modeOf = (routeType: string): Mode => {
  const t = Number(routeType);
  if (t === 2 || (t >= 100 && t < 200)) return 'train';
  if (t === 3 || (t >= 200 && t < 300) || (t >= 700 && t < 800)) return 'bus';
  return 'other';
};

/** Odległość w metrach (przybliżenie równoprostokątne — wystarcza do kilkuset metrów). */
export function distanceM(a: Stop, b: Stop): number {
  const x = ((b.lon - a.lon) * Math.PI * Math.cos(((a.lat + b.lat) * Math.PI) / 360)) / 180;
  const y = ((b.lat - a.lat) * Math.PI) / 180;
  return Math.sqrt(x * x + y * y) * 6_371_000;
}

interface Calendar {
  days: number[];
  from: string;
  to: string;
}

export class Timetable {
  readonly stops: Stop[] = [];
  readonly trips: Trip[] = [];
  stNode = new Int32Array(0);
  stArr = new Int32Array(0);
  stDep = new Int32Array(0);
  stSeq = new Int32Array(0);
  stFlags = new Uint8Array(0);
  stPlatform = new Int32Array(0);
  readonly platforms: string[] = [''];
  /** Przesiadki piesze: [przystanek, sekundy]. */
  readonly foot: Array<Array<[number, number]>> = [];
  private readonly calendars = new Map<string, Calendar>();
  private readonly added = new Map<string, Set<string>>();
  private readonly removed = new Map<string, Set<string>>();
  readonly loadedAt = new Date();
  readonly sources: string[] = [];

  constructor(feeds: readonly FeedFiles[]) {
    const nodeOf = new Map<string, number>();
    const rows: Array<{
      trip: number;
      seq: number;
      node: number;
      arr: number;
      dep: number;
      flags: number;
      pl: number;
    }> = [];
    const platformIx = new Map<string, number>([['', 0]]);
    for (const f of feeds) {
      const p = f.prefix;
      const info = table(f, 'feed_info.txt')[0];
      this.sources.push(info?.feed_publisher_name ?? p);
      // Stacje i przystanki; perony (parent_station) należą do stacji.
      const stops = table(f, 'stops.txt');
      for (const s of stops) {
        if (s.parent_station) continue;
        nodeOf.set(p + s.stop_id, this.stops.length);
        this.stops.push({
          name: s.stop_name ?? '',
          norm: normName(s.stop_name ?? ''),
          lat: Number(s.stop_lat),
          lon: Number(s.stop_lon),
        });
      }
      for (const s of stops) {
        const parent = s.parent_station ? nodeOf.get(p + s.parent_station) : undefined;
        if (parent !== undefined) nodeOf.set(p + s.stop_id, parent);
      }
      const agencies = new Map(
        table(f, 'agency.txt').map((a) => [a.agency_id ?? '', a.agency_name ?? '']),
      );
      const routes = new Map(table(f, 'routes.txt').map((r) => [r.route_id, r]));
      for (const c of table(f, 'calendar.txt')) {
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
          .map((d, i) => (c[d] === '1' ? i : -1))
          .filter((i) => i >= 0);
        this.calendars.set(p + c.service_id, { days, from: c.start_date!, to: c.end_date! });
      }
      for (const d of table(f, 'calendar_dates.txt')) {
        const m = d.exception_type === '1' ? this.added : this.removed;
        const key = p + d.service_id;
        if (!m.has(key)) m.set(key, new Set());
        m.get(key)!.add(d.date!);
      }
      const tripOf = new Map<string, number>();
      for (const t of table(f, 'trips.txt')) {
        const r = routes.get(t.route_id!);
        const agency = agencies.get(r?.agency_id ?? '') || [...agencies.values()][0] || '';
        const number = t.trip_short_name || t.plk_train_number || '';
        tripOf.set(t.trip_id!, this.trips.length);
        this.trips.push({
          id: t.trip_id!,
          feed: p,
          service: p + t.service_id,
          mode: modeOf(r?.route_type ?? ''),
          label: [agency, r?.route_short_name, number].filter(Boolean).join(' '),
          headsign: t.trip_headsign ?? '',
          start: 0,
          len: 0,
        });
      }
      const st = f.files.get('stop_times.txt');
      if (!st) continue;
      const it = csvRows(st);
      const head = (it.next().value as string[]).map((h) => h.trim());
      const ix = (h: string) => head.indexOf(h);
      const [iTrip, iSeq, iStop, iArr, iDep, iPick, iDrop, iPlat, iTrack] = [
        ix('trip_id'),
        ix('stop_sequence'),
        ix('stop_id'),
        ix('arrival_time'),
        ix('departure_time'),
        ix('pickup_type'),
        ix('drop_off_type'),
        ix('platform'),
        ix('track'),
      ];
      for (const r of it) {
        const trip = tripOf.get(r[iTrip]!);
        const node = nodeOf.get(p + r[iStop]);
        const a = r[iArr] || r[iDep];
        const d = r[iDep] || r[iArr];
        if (trip === undefined || node === undefined || !a || !d) continue;
        const flags = (r[iPick] === '1' ? NO_PICKUP : 0) | (r[iDrop] === '1' ? NO_DROPOFF : 0);
        const plat = [
          iPlat >= 0 && r[iPlat] ? `peron ${r[iPlat]}` : '',
          iTrack >= 0 && r[iTrack] ? `tor ${r[iTrack]}` : '',
        ]
          .filter(Boolean)
          .join(', ');
        let pl = platformIx.get(plat);
        if (pl === undefined) {
          pl = this.platforms.length;
          platformIx.set(plat, pl);
          this.platforms.push(plat);
        }
        rows.push({ trip, seq: Number(r[iSeq]), node, arr: secs(a), dep: secs(d), flags, pl });
      }
    }
    // Przystanki kursu po kolei (GTFS nie gwarantuje kolejności wierszy).
    rows.sort((x, y) => x.trip - y.trip || x.seq - y.seq);
    const n = rows.length;
    this.stNode = new Int32Array(n);
    this.stArr = new Int32Array(n);
    this.stDep = new Int32Array(n);
    this.stSeq = new Int32Array(n);
    this.stFlags = new Uint8Array(n);
    this.stPlatform = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const r = rows[i]!;
      this.stNode[i] = r.node;
      this.stArr[i] = r.arr;
      this.stDep[i] = r.dep;
      this.stSeq[i] = r.seq;
      this.stFlags[i] = r.flags;
      this.stPlatform[i] = r.pl;
      const t = this.trips[r.trip]!;
      if (t.len === 0) t.start = i;
      t.len++;
    }
    this.buildFootpaths();
  }

  /** Przesiadki piesze do pobliskich przystanków (siatka ~500 m, bez porównywania wszystkich par). */
  private buildFootpaths(): void {
    const cell = (s: Stop) => `${Math.floor(s.lat / 0.005)}:${Math.floor(s.lon / 0.0075)}`;
    const grid = new Map<string, number[]>();
    this.stops.forEach((s, i) => {
      const k = cell(s);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k)!.push(i);
    });
    this.stops.forEach((s, i) => {
      const out: Array<[number, number]> = [];
      const la = Math.floor(s.lat / 0.005);
      const lo = Math.floor(s.lon / 0.0075);
      for (let a = la - 1; a <= la + 1; a++)
        for (let b = lo - 1; b <= lo + 1; b++)
          for (const j of grid.get(`${a}:${b}`) ?? []) {
            if (j === i) continue;
            const d = distanceM(s, this.stops[j]!);
            if (d <= WALK_RADIUS_M)
              out.push([j, Math.ceil((d * WALK_DETOUR) / WALK_SPEED_MS) + WALK_BUFFER_S]);
          }
      out.sort((x, y) => x[1] - y[1]);
      this.foot.push(out.slice(0, 12));
    });
  }

  /** Czy kurs z danego kalendarza jedzie w dniu RRRRMMDD. */
  runsOn(service: string, date: string): boolean {
    if (this.removed.get(service)?.has(date)) return false;
    if (this.added.get(service)?.has(date)) return true;
    const c = this.calendars.get(service);
    if (!c || date < c.from || date > c.to) return false;
    const day = new Date(
      Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8))),
    ).getUTCDay();
    return c.days.includes(day);
  }

  canBoard(st: number): boolean {
    return (this.stFlags[st]! & NO_PICKUP) === 0;
  }

  canAlight(st: number): boolean {
    return (this.stFlags[st]! & NO_DROPOFF) === 0;
  }
}
