import ICAL from 'ical.js';

/**
 * Odczyt pliku iCalendar (.ics) — np. planu zajęć z dziekanatu, eksportu z Google lub Outlooka. Tylko odczyt:
 * wydarzenia (tytuł, czas, miejsce, opis), powtarzanie (RRULE, EXDATE, zmienione wystąpienia) rozwijane
 * w oknie dat. Czas ze strefą bez definicji w pliku (częste w systemach uczelnianych) i czas „pływający”
 * liczony w podanej strefie IANA, a gdy jej brak lub nie jest znana — w Europe/Warsaw.
 */
export const DEFAULT_ZONE = 'Europe/Warsaw';

export interface IcsEvent {
  title: string;
  startsAt: Date;
  endsAt: Date;
  location: string | null;
  notes: string | null;
}

export interface IcsResult {
  events: IcsEvent[];
  /** Wydarzenia poza oknem dat, odwołane albo ponad limit. */
  skipped: number;
}

export class IcsError extends Error {}

const MAX_OCCURRENCES_PER_EVENT = 2000;

/** Tekst z pliku: bez znaków sterujących, przycięty. */
function clean(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  return s ? s.slice(0, max) : null;
}

/** Klucze opisu powtarzające to, co już jest w wydarzeniu (tytuł, czas) — pomijane w szczegółach. */
const REDUNDANT_KEYS = new Set([
  'plan dla toku',
  'data zajęć',
  'czas od',
  'czas do',
  'liczba godzin',
  'przedmiot',
]);
const ROOM_KEYS = new Set(['sala', 'miejsce', 'room', 'location']);

/**
 * Opis w liniach „Klucz: wartość” (np. Wirtualny Dziekanat IDEIS: „Sala: …”, „Prowadzący: …”): sala do miejsca,
 * reszta zwięźle („Grupy: Konw; Prowadzący: …”), bez powtórzeń tytułu i czasu oraz pustych pól.
 * Opis bez takich linii zostaje bez zmian.
 */
export function splitDescription(text: string | null): {
  room: string | null;
  notes: string | null;
} {
  if (!text) return { room: null, notes: null };
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const pairs = lines.map((l) => /^([^:]{1,40}):\s*(.*)$/.exec(l));
  if (!pairs.some(Boolean)) return { room: null, notes: text };
  let room: string | null = null;
  const rest: string[] = [];
  pairs.forEach((m, i) => {
    if (!m) return void rest.push(lines[i]!);
    const key = m[1]!.trim();
    const value = m[2]!.trim();
    if (!value || REDUNDANT_KEYS.has(key.toLowerCase())) return;
    if (ROOM_KEYS.has(key.toLowerCase())) room ??= value;
    else rest.push(`${key}: ${value}`);
  });
  return { room, notes: rest.join('; ') || null };
}

function validZone(tz: string | undefined): string {
  if (!tz) return DEFAULT_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_ZONE;
  }
}

/** Przesunięcie strefy (lokalny czas − UTC) w chwili `utcMs`. */
function zoneOffset(utcMs: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(utcMs)
      .map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Czas „na zegarze” w strefie `tz` → chwila UTC (z uwzględnieniem zmiany czasu). */
export function wallClockToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  tz: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = guess - zoneOffset(guess, tz);
  const second = guess - zoneOffset(first, tz);
  return new Date(second);
}

function toDate(t: ICAL.Time, fallbackZone: string): Date {
  if (t.isDate) return wallClockToUtc(t.year, t.month, t.day, 0, 0, 0, fallbackZone);
  const tzid = t.zone?.tzid;
  if (tzid === 'UTC') return new Date(t.toUnixTime() * 1000);
  if (tzid && tzid !== 'floating') return new Date(t.toUnixTime() * 1000);
  return wallClockToUtc(t.year, t.month, t.day, t.hour, t.minute, t.second, fallbackZone);
}

export function parseIcs(
  text: string,
  window: { from: Date; to: Date; maxEvents: number },
): IcsResult {
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new IcsError('To nie jest plik kalendarza (.ics)');
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(text.replace(/^\uFEFF/, '')));
  } catch {
    throw new IcsError('Nie da się odczytać pliku kalendarza — plik jest uszkodzony');
  }
  const vevents = root.getAllSubcomponents('vevent');
  // Zmienione pojedyncze wystąpienia (RECURRENCE-ID) należą do wydarzenia głównego o tym samym UID.
  const uidOf = (v: ICAL.Component) => String(v.getFirstPropertyValue('uid') ?? '');
  const exceptions = new Map<string, ICAL.Component[]>();
  const masters = new Set<string>();
  for (const v of vevents) {
    if (!v.hasProperty('recurrence-id')) masters.add(uidOf(v));
    else exceptions.set(uidOf(v), [...(exceptions.get(uidOf(v)) ?? []), v]);
  }

  const events: IcsEvent[] = [];
  let skipped = 0;
  const from = window.from.getTime();
  const to = window.to.getTime();
  const push = (e: IcsEvent, cancelled: boolean) => {
    if (cancelled || e.endsAt.getTime() <= from || e.startsAt.getTime() >= to) skipped++;
    else if (events.length >= window.maxEvents) skipped++;
    else events.push(e);
  };

  for (const v of vevents) {
    const uid = uidOf(v);
    // Wyjątek z wydarzeniem głównym jest obsłużony przy rozwijaniu powtórzeń.
    if (v.hasProperty('recurrence-id') && masters.has(uid)) continue;
    let ev: ICAL.Event;
    try {
      ev = new ICAL.Event(v);
    } catch {
      skipped++;
      continue;
    }
    if (!ev.startDate) {
      skipped++;
      continue;
    }
    const zone = validZone(
      (v.getFirstProperty('dtstart')?.getParameter('tzid') as string | undefined) ?? undefined,
    );
    const build = (
      start: ICAL.Time,
      end: ICAL.Time | null,
      item: ICAL.Event,
    ): { e: IcsEvent; cancelled: boolean } => {
      const startsAt = toDate(start, zone);
      let endsAt = end ? toDate(end, zone) : null;
      if (!endsAt || endsAt <= startsAt)
        endsAt = new Date(startsAt.getTime() + (start.isDate ? 86_400_000 : 3_600_000));
      const status = String(item.component.getFirstPropertyValue('status') ?? '').toUpperCase();
      const described = splitDescription(clean(item.description, 2000));
      return {
        e: {
          title: clean(item.summary, 200) ?? '(bez tytułu)',
          startsAt,
          endsAt,
          location: clean(item.location, 200) ?? clean(described.room, 200),
          notes: clean(described.notes, 500),
        },
        cancelled: status === 'CANCELLED',
      };
    };

    if (!ev.isRecurring()) {
      const { e, cancelled } = build(ev.startDate, ev.endDate ?? null, ev);
      push(e, cancelled);
      continue;
    }
    for (const x of exceptions.get(uid) ?? []) ev.relateException(x);
    const it = ev.iterator();
    for (let n = 0; n < MAX_OCCURRENCES_PER_EVENT; n++) {
      const next = it.next();
      if (!next) break;
      const d = ev.getOccurrenceDetails(next);
      const { e, cancelled } = build(d.startDate, d.endDate, d.item);
      if (e.startsAt.getTime() >= to) break;
      push(e, cancelled);
    }
  }
  events.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return { events, skipped };
}
