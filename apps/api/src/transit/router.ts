import { normName, type Mode, type Timetable } from './gtfs';

/**
 * Wyszukiwanie połączeń (Connection Scan Algorithm): najwcześniejszy przyjazd z przesiadkami i przejściami
 * pieszymi; kolejne połączenia — szukanie od późniejszego odjazdu. „Przyjazd do” — połączenia, które zdążą,
 * z najpóźniejszym odjazdem. Wynik tylko z rozkładów (bez zgadywania).
 */
const DAY = 86_400;
/** Minimalny czas na przesiadkę na tej samej stacji. */
export const CHANGE_S = 240;
const INF = 0x7fffffff;

export interface Connections {
  date: string;
  dep: Int32Array;
  arr: Int32Array;
  from: Int32Array;
  to: Int32Array;
  trip: Int32Array;
  /** Indeksy w tablicach przystanków kursu: odjazd i przyjazd. */
  stFrom: Int32Array;
  stTo: Int32Array;
}

export interface Leg {
  kind: 'ride' | 'walk';
  from: number;
  to: number;
  dep: number;
  arr: number;
  trip?: number;
  stFrom?: number;
  stTo?: number;
}

export interface Journey {
  dep: number;
  arr: number;
  legs: Leg[];
}

/** RRRR-MM-DD → RRRRMMDD dnia wcześniejszego (kursy z poprzedniego dnia po północy). */
function prevDay(date: string): string {
  const d = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** Odcinki między kolejnymi przystankami wszystkich kursów jadących w danym dniu, posortowane po odjeździe. */
export function connectionsOn(tt: Timetable, date: string): Connections {
  const prev = prevDay(date);
  const list: number[][] = [];
  tt.trips.forEach((t, ti) => {
    const today = tt.runsOn(t.service, date);
    const yesterday = tt.runsOn(t.service, prev);
    if (!today && !yesterday) return;
    for (let k = t.start; k < t.start + t.len - 1; k++) {
      const dep = tt.stDep[k]!;
      const arr = tt.stArr[k + 1]!;
      if (today) list.push([dep, arr, tt.stNode[k]!, tt.stNode[k + 1]!, ti, k, k + 1]);
      // Kurs z poprzedniego dnia, który jedzie już po północy.
      if (yesterday && dep >= DAY)
        list.push([dep - DAY, arr - DAY, tt.stNode[k]!, tt.stNode[k + 1]!, ti, k, k + 1]);
    }
  });
  list.sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
  const col = (i: number) => Int32Array.from(list, (r) => r[i]!);
  return {
    date,
    dep: col(0),
    arr: col(1),
    from: col(2),
    to: col(3),
    trip: col(4),
    stFrom: col(5),
    stTo: col(6),
  };
}

/** Najwcześniejszy przyjazd do któregoś z celów przy odjeździe od `t0` z któregoś ze źródeł. */
export function earliest(
  tt: Timetable,
  c: Connections,
  sources: readonly number[],
  targets: readonly number[],
  t0: number,
): Journey | null {
  const n = tt.stops.length;
  const arrival = new Int32Array(n).fill(INF);
  const ready = new Int32Array(n).fill(INF);
  const inConn = new Int32Array(n).fill(-1);
  const walkFrom = new Int32Array(n).fill(-1);
  const board = new Map<number, number>();
  const isTarget = new Set(targets);
  const isSource = new Set(sources);
  let best = INF;
  let bestNode = -1;
  const reach = (node: number, t: number) => {
    if (isTarget.has(node) && t < best) {
      best = t;
      bestNode = node;
    }
  };
  const walk = (from: number, t: number) => {
    for (const [nb, w] of tt.foot[from] ?? []) {
      if (t + w < arrival[nb]! && !isSource.has(nb)) {
        arrival[nb] = t + w;
        ready[nb] = t + w;
        inConn[nb] = -1;
        walkFrom[nb] = from;
        reach(nb, t + w);
      }
    }
  };
  for (const s of sources) {
    arrival[s] = t0;
    ready[s] = t0;
    reach(s, t0);
  }
  for (const s of sources) walk(s, t0);
  // Pierwszy odcinek z odjazdem ≥ t0 (wyszukiwanie binarne).
  let lo = 0;
  let hi = c.dep.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (c.dep[mid]! < t0) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < c.dep.length; i++) {
    if (c.dep[i]! >= best) break;
    const trip = c.trip[i]!;
    // Klucz kursu z przesunięciem doby: ten sam kurs wczoraj i dziś to różne przejazdy.
    const key = trip * 2 + (c.dep[i]! < tt.stDep[c.stFrom[i]!]! ? 1 : 0);
    if (!board.has(key)) {
      if (ready[c.from[i]!]! > c.dep[i]! || !tt.canBoard(c.stFrom[i]!)) continue;
      board.set(key, i);
    }
    const to = c.to[i]!;
    const a = c.arr[i]!;
    if (a < arrival[to]! && tt.canAlight(c.stTo[i]!) && !isSource.has(to)) {
      arrival[to] = a;
      ready[to] = a + CHANGE_S;
      inConn[to] = i;
      walkFrom[to] = -1;
      reach(to, a);
      walk(to, a);
    }
  }
  if (bestNode < 0) return null;
  // Odtworzenie trasy od celu do źródła.
  const legs: Leg[] = [];
  let node = bestNode;
  for (let guard = 0; guard < 30 && !isSource.has(node); guard++) {
    const i = inConn[node]!;
    if (i >= 0) {
      const key = c.trip[i]! * 2 + (c.dep[i]! < tt.stDep[c.stFrom[i]!]! ? 1 : 0);
      const b = board.get(key)!;
      legs.unshift({
        kind: 'ride',
        from: c.from[b]!,
        to: node,
        dep: c.dep[b]!,
        arr: c.arr[i]!,
        trip: c.trip[i]!,
        stFrom: c.stFrom[b]!,
        stTo: c.stTo[i]!,
      });
      node = c.from[b]!;
    } else if (walkFrom[node]! >= 0) {
      const from = walkFrom[node]!;
      const dur = (tt.foot[from]?.find(([nb]) => nb === node)?.[1] ?? 0) as number;
      legs.unshift({
        kind: 'walk',
        from,
        to: node,
        dep: arrival[node]! - dur,
        arr: arrival[node]!,
      });
      node = from;
    } else break;
  }
  const rides = legs.filter((l) => l.kind === 'ride');
  if (!rides.length) return null;
  // Spacer na początku (z innego przystanku źródłowego) — odjazd liczony od pierwszego przejazdu.
  while (legs[0]?.kind === 'walk') legs.shift();
  return { dep: legs[0]!.dep, arr: best, legs };
}

/**
 * Kilka połączeń: od `t0` (odjazd) albo z przyjazdem do `deadline`. Połączenie gorsze od następnego
 * (ten sam przyjazd, wcześniejszy odjazd) jest pomijane.
 */
export function journeys(
  tt: Timetable,
  c: Connections,
  sources: readonly number[],
  targets: readonly number[],
  opts: { t0: number; count: number; deadline?: number },
): Journey[] {
  const out: Journey[] = [];
  let t = opts.deadline !== undefined ? Math.max(0, opts.deadline - 4 * 3600) : opts.t0;
  for (let k = 0; k < 25; k++) {
    const j = earliest(tt, c, sources, targets, t);
    if (!j) break;
    if (opts.deadline !== undefined && j.arr > opts.deadline) break;
    if (out.length && out[out.length - 1]!.arr >= j.arr) out.pop();
    out.push(j);
    // O jedno więcej: następne połączenie może przyjechać wcześniej niż ostatnie (to ostatnie odpada).
    if (opts.deadline === undefined && out.length > opts.count) {
      out.pop();
      break;
    }
    t = j.dep + 60;
  }
  return opts.deadline !== undefined ? out.slice(-opts.count) : out;
}

export interface Resolved {
  ids: number[];
  names: string[];
}

/**
 * Nazwa → przystanki. Cel: dokładna nazwa, inaczej „<miasto> Główny”, inaczej przystanki w mieście.
 * Start: stacja główna miasta albo dokładna nazwa plus przystanki w tym mieście (np. dworzec autobusowy).
 */
export function resolveStops(tt: Timetable, query: string, role: 'from' | 'to'): Resolved {
  const q = normName(query);
  if (!q) return { ids: [], names: [] };
  const exact: number[] = [];
  const main: number[] = [];
  const prefix: number[] = [];
  const words: number[] = [];
  const tokens = q.split(' ');
  tt.stops.forEach((s, i) => {
    if (s.norm === q) exact.push(i);
    else if (s.norm === `${q} glowny`) main.push(i);
    else if (s.norm.startsWith(`${q} `)) prefix.push(i);
    else if (tokens.every((t) => s.norm.includes(t))) words.push(i);
  });
  // „Kraków” → Kraków Główny; „Andrychów” → stacja i przystanki w mieście (dworzec autobusowy itd.);
  // „Kraków Główny” → tylko ta stacja (przystanki obok — przez przejścia piesze).
  const ids0 = main.length ? [...main, ...exact] : [...exact, ...prefix];
  let ids = (role === 'to' && main.length ? main : ids0).slice(0, 40);
  if (!ids.length) ids = words.slice(0, 20);
  return { ids, names: [...new Set(ids.map((i) => tt.stops[i]!.name))] };
}

/** Podpowiedzi przy nieznanej nazwie: przystanki zawierające któreś słowo zapytania. */
export function similarStops(tt: Timetable, query: string, limit = 6): string[] {
  const tokens = normName(query)
    .split(' ')
    .filter((t) => t.length >= 3);
  const names = new Set<string>();
  for (const s of tt.stops) {
    if (tokens.some((t) => s.norm.includes(t.slice(0, Math.max(3, t.length - 2)))))
      names.add(s.name);
    if (names.size >= limit) break;
  }
  return [...names];
}

export const MODE_PL: Record<Mode, string> = { train: 'pociąg', bus: 'autobus', other: 'kurs' };
