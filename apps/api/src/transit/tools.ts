import { z } from 'zod';
import { wallClockToUtc } from '../calendar/ics';
import { warsawClock } from '../digest/service';
import type { ToolDef } from '../tools/types';
import type { Timetable } from './gtfs';
import { journeys, MODE_PL, resolveStops, similarStops, type Journey } from './router';
import { REALTIME_FEED, type Live } from './source';

type SearchParams = {
  from: string;
  to: string;
  date?: string;
  time?: string;
  arriveBy: boolean;
  count: number;
};

const DAY = 86_400;
const hhmm = (s: number) => {
  const t = ((s % DAY) + DAY) % DAY;
  return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`;
};
/** Czas między godzinami tak, jak je widać („06:30 → 07:12” = 42 min). */
const duration = (from: number, to: number) => {
  const m = Math.floor(to / 60) - Math.floor(from / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};
const dayLabel = (date: string) =>
  new Intl.DateTimeFormat('pl-PL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));

/** Opóźnienie (min) i odwołanie z danych na żywo dla przystanku kursu w dniu kursowania. */
function liveAt(
  tt: Timetable,
  live: Live | null,
  trip: number,
  st: number,
  serviceDate: string,
  kind: 'arr' | 'dep',
): { delay: number | null; cancelled: boolean } {
  const t = tt.trips[trip]!;
  if (!live || t.feed !== REALTIME_FEED) return { delay: null, cancelled: false };
  const u = live.get(`${t.id}|${serviceDate}`);
  if (!u) return { delay: null, cancelled: false };
  const s = u.stops.get(tt.stSeq[st]!);
  const at = s?.[kind];
  if (u.cancelled || s?.cancelled) return { delay: null, cancelled: true };
  if (at === undefined) return { delay: null, cancelled: false };
  const [y, m, d] = serviceDate.split('-').map(Number);
  const planned = wallClockToUtc(
    y!,
    m!,
    d!,
    0,
    0,
    kind === 'arr' ? tt.stArr[st]! : tt.stDep[st]!,
    'Europe/Warsaw',
  ).getTime();
  return { delay: Math.round((at - planned) / 60_000), cancelled: false };
}

const delayText = (x: { delay: number | null; cancelled: boolean }) =>
  x.cancelled ? ' [ODWOŁANY]' : x.delay && x.delay >= 2 ? ` [opóźnienie +${x.delay} min]` : '';

/** Połączenia dla modelu i użytkownika: godziny, przesiadki, perony, opóźnienia. */
export function describeJourneys(
  tt: Timetable,
  list: Journey[],
  date: string,
  live: Live | null,
): string[] {
  const prev = new Date(`${date}T12:00:00Z`);
  prev.setUTCDate(prev.getUTCDate() - 1);
  const prevDate = prev.toISOString().slice(0, 10);
  return list.flatMap((j, n) => {
    const rides = j.legs.filter((l) => l.kind === 'ride');
    const changes = rides.length - 1;
    const lines = [
      `${n + 1}) ${hhmm(j.dep)} → ${hhmm(j.arr)} (${duration(j.dep, j.arr)}, ${changes ? `przesiadki: ${changes}` : 'bez przesiadek'})`,
    ];
    for (const l of j.legs) {
      if (l.kind === 'walk') {
        lines.push(
          `   pieszo ${duration(l.dep, l.arr)}: ${tt.stops[l.from]!.name} → ${tt.stops[l.to]!.name}`,
        );
        continue;
      }
      const t = tt.trips[l.trip!]!;
      // Kurs z poprzedniego dnia (po północy): dane na żywo wg daty rozpoczęcia kursu.
      const serviceDate = l.dep < tt.stDep[l.stFrom!]! ? prevDate : date;
      const dep = liveAt(tt, live, l.trip!, l.stFrom!, serviceDate, 'dep');
      const arr = liveAt(tt, live, l.trip!, l.stTo!, serviceDate, 'arr');
      const platform = tt.platforms[tt.stPlatform[l.stFrom!]!];
      lines.push(
        `   ${MODE_PL[t.mode]} ${t.label}${t.headsign ? ` (kierunek ${t.headsign})` : ''}: ${tt.stops[l.from]!.name} ${hhmm(l.dep)}${platform ? ` (${platform})` : ''}${delayText(dep)} → ${tt.stops[l.to]!.name} ${hhmm(l.arr)}${arr.cancelled ? '' : delayText(arr)}`,
      );
    }
    return lines;
  });
}

/**
 * „Jak dojadę jutro na 10 do Krakowa?” — połączenia z rozkładów (pociągi wszystkich przewoźników, autobusy
 * Kolei Małopolskich), z opóźnieniami na żywo dla pociągów dziś. Zamiast wyszukiwania w internecie.
 */
export const transitSearchTool: ToolDef<SearchParams> = {
  name: 'transit.search',
  capability: 'transit.search',
  title:
    'Wyszukaj połączenia komunikacją publiczną w Polsce (pociągi wszystkich przewoźników, autobusy Kolei Małopolskich) z oficjalnych rozkładów, z opóźnieniami na żywo: from, to — nazwy stacji/przystanków albo miast (np. „Andrychów”, „Kraków Główny”); date RRRR-MM-DD (domyślnie dziś); time GG:MM; arriveBy=true — time to godzina, na którą trzeba dojechać (np. zajęcia o 10:00 → 09:40 z zapasem na dojście). Używaj zamiast wyszukiwania w internecie; godziny podawaj wyłącznie z wyniku',
  contexts: ['private_agent', 'household_agent'],
  readOnly: true,
  params: z.object({
    from: z.string().trim().min(2).max(100),
    to: z.string().trim().min(2).max(100),
    date: z.iso.date().optional(),
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    arriveBy: z.boolean().default(false),
    count: z.number().int().min(1).max(6).default(4),
  }) as unknown as z.ZodType<SearchParams>,
  requiresApproval: () => false,
  async preview(_ctx, p) {
    return {
      summary: `Połączenia: ${p.from} → ${p.to}`,
      target: 'rozkłady jazdy',
      scope: 'odczyt',
    };
  },
  async authorize() {
    return { allow: true, reason: 'public_timetable' };
  },
  async execute(ctx, p) {
    const now = warsawClock(new Date());
    const date = p.date ?? now.date;
    const ymd = date.replace(/-/g, '');
    const { tt, c } = await ctx.deps.transit.connections(ymd);
    const from = resolveStops(tt, p.from, 'from');
    const to = resolveStops(tt, p.to, 'to');
    for (const [q, r] of [
      [p.from, from],
      [p.to, to],
    ] as const) {
      if (!r.ids.length) {
        const like = similarStops(tt, q);
        return {
          summary: `Nie znam przystanku „${q}”`,
          output: {
            lines: [
              like.length
                ? `Podobne nazwy w rozkładach: ${like.join(', ')}`
                : 'Brak podobnych nazw.',
            ],
          },
        };
      }
    }
    const [h, m] = (p.time ?? (date === now.date ? '' : '05:00')).split(':').map(Number);
    const t = p.time || date !== now.date ? h! * 3600 + m! * 60 : now.minutes * 60;
    const list = journeys(tt, c, from.ids, to.ids, {
      t0: t,
      count: p.count,
      ...(p.arriveBy ? { deadline: t } : {}),
    });
    const live = date === now.date ? await ctx.deps.transit.realtime() : null;
    const head = `${from.names.slice(0, 3).join(' / ')} → ${to.names.slice(0, 3).join(' / ')}, ${dayLabel(date)}${p.arriveBy ? `, przyjazd do ${hhmm(t)}` : `, odjazd od ${hhmm(t)}`}`;
    return {
      summary: `Połączenia: ${head}`,
      output: {
        lines: [
          ...(list.length
            ? describeJourneys(tt, list, date, live)
            : ['Brak połączeń w rozkładach w tym czasie (sprawdź datę albo godzinę).']),
          `Źródło: rozkłady ${tt.sources.join(', ')}, pobrane ${tt.loadedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC${live ? '; opóźnienia pociągów na żywo' : ''}. Prywatni przewoźnicy busów nie są uwzględnieni.`,
        ],
      },
    };
  },
};
