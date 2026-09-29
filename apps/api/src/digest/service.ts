import { roomAndNotes } from '../calendar/ics';
import { withSystemTx, withUserTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { emitEvent } from '../events';
import { formatMoney, paymentsDueOn } from '../expenses/service';
import { shortList } from '../shopping/service';
import { weatherText, type DayWeather } from '../weather/openmeteo';

/**
 * Przeglądy dnia wysyłane automatycznie: rano (domyślnie 7:00) — co dziś, wieczorem (22:00) — co jutro.
 * Treść: wydarzenia z kalendarza (plan zajęć z salami), przypomnienia, odnowienia usług, pogoda. Powstaje
 * jako zwykłe powiadomienie (Dom → Wiadomości), więc trafia też jako push. Bez modelu i bez kosztów;
 * dane przez RLS osoby (własne + wspólne), jak w pozostałych widokach.
 */
export const TZ = 'Europe/Warsaw';
export type DigestKind = 'morning' | 'evening';
/** Spóźnienie, po którym przegląd nie jest już wysyłany (np. serwer wyłączony rano). */
const GRACE_MINUTES = 90;
const MAX_ITEMS = 8;

export interface DigestUser {
  userId: string;
  householdId: string;
  displayName: string;
}

export interface Digest {
  title: string;
  body: string;
}

const time = (iso: string | Date) =>
  new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: TZ }).format(
    new Date(iso),
  );
const firstName = (displayName: string) => displayName.replace(/\s*\(.*\)\s*$/, '').trim();

/** Data i minuty od północy w czasie polskim. */
export function warsawClock(now: Date): { date: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

const dayLabel = (isoDate: string) =>
  new Intl.DateTimeFormat('pl-PL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${isoDate}T12:00:00Z`));

/** Pogoda domu na dany dzień (null: brak miejsca albo błąd usługi — przegląd idzie bez pogody). */
export async function weatherFor(
  deps: AppDeps,
  householdId: string,
  date: string,
): Promise<DayWeather | null> {
  const r = await deps.db.owner.query<{ latitude: number; longitude: number }>(
    'SELECT latitude, longitude FROM household_weather WHERE household_id = $1',
    [householdId],
  );
  const place = r.rows[0];
  if (!place) return null;
  try {
    const days = await deps.weather.forecast(place.latitude, place.longitude);
    return days.find((d) => d.date === date) ?? null;
  } catch {
    return null;
  }
}

/** Treść przeglądu: rano — dziś, wieczorem — jutro. */
export async function buildDigest(
  deps: AppDeps,
  user: DigestUser,
  kind: DigestKind,
  now = new Date(),
): Promise<Digest> {
  const offset = kind === 'morning' ? 0 : 1;
  const day = `(date_trunc('day', $1::timestamptz AT TIME ZONE '${TZ}') + make_interval(days => ${offset}))`;
  const start = `(${day} AT TIME ZONE '${TZ}')`;
  const end = `((${day} + interval '1 day') AT TIME ZONE '${TZ}')`;
  const data = await withUserTx(deps.db, { userId: user.userId, scope: 'user' }, async (c) => {
    const date = await c.query<{ date: string }>(`SELECT to_char(${day}, 'YYYY-MM-DD') AS date`, [
      now,
    ]);
    const events = await c.query<{
      title: string;
      starts_at: string;
      location: string | null;
      notes: string | null;
    }>(
      `SELECT title, starts_at, location, notes FROM local_calendar_events
        WHERE owner_user_id = nova_uid() AND NOT hidden AND starts_at < ${end} AND ends_at > ${start}
        ORDER BY starts_at LIMIT ${MAX_ITEMS}`,
      [now],
    );
    const reminders = await c.query<{ text: string; due_at: string; visibility: string }>(
      `SELECT text, due_at, visibility FROM reminders
        WHERE household_id = $2 AND status = 'scheduled' AND due_at >= ${start} AND due_at < ${end}
          AND (visibility = 'shared' OR owner_user_id = nova_uid())
        ORDER BY due_at LIMIT ${MAX_ITEMS}`,
      [now, user.householdId],
    );
    const renewals = await c.query<{ name: string }>(
      `SELECT name FROM services
        WHERE household_id = $2 AND status IN ('active', 'trial') AND renews_on = ${day}::date
          AND (visibility = 'shared' OR owner_user_id = nova_uid())
        ORDER BY name LIMIT ${MAX_ITEMS}`,
      [now, user.householdId],
    );
    const shopping = await c.query<{ text: string }>(
      `SELECT text FROM shopping_items WHERE household_id = $1 AND checked_at IS NULL
        ORDER BY created_at`,
      [user.householdId],
    );
    const targetDate = date.rows[0]!.date;
    const payments = await paymentsDueOn(c, user.householdId, targetDate);
    return { date: targetDate, events, reminders, renewals, shopping, payments };
  });

  const lines: string[] = [];
  for (const e of data.events.rows) {
    const room = roomAndNotes(e.location, e.notes).room;
    lines.push(`${time(e.starts_at)} ${e.title}${room ? ` (sala: ${room})` : ''}`);
  }
  for (const r of data.reminders.rows)
    lines.push(
      `Przypomnienie ${time(r.due_at)}: ${r.text}${r.visibility === 'shared' ? ' (wspólne)' : ''}`,
    );
  for (const s of data.renewals.rows) lines.push(`Odnowienie usługi: ${s.name}`);
  for (const p of data.payments)
    lines.push(
      `Płatność: ${p.name} — ${formatMoney(p.amount, p.currency)}${p.visibility === 'shared' ? ' (wspólna)' : ''}`,
    );
  if (data.shopping.rows.length)
    lines.push(`Lista zakupów: ${shortList(data.shopping.rows.map((x) => x.text))}`);
  if (!lines.length)
    lines.push(kind === 'morning' ? 'Nic w planie na dziś.' : 'Nic w planie na jutro.');
  const w = await weatherFor(deps, user.householdId, data.date);
  if (w) lines.push(`Pogoda: ${weatherText(w)}`);

  const name = firstName(user.displayName);
  const title =
    kind === 'morning'
      ? `Dzień dobry${name ? `, ${name}` : ''} — dziś ${dayLabel(data.date)}`
      : `Jutro: ${dayLabel(data.date)}`;
  return { title, body: lines.join('\n') };
}

interface Recipient extends DigestUser {
  morning: boolean;
  morning_at: string;
  evening: boolean;
  evening_at: string;
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/**
 * Wysyłka należnych przeglądów (wywoływana co minutę). Każdy rodzaj raz dziennie na osobę (digest_runs);
 * po przekroczeniu okna (90 min) — pominięty. Tylko osoby, które choć raz się zalogowały.
 */
export async function runDueDigests(deps: AppDeps, now = new Date()): Promise<number> {
  const clock = warsawClock(now);
  const people = await deps.db.owner.query<Recipient>(
    `SELECT u.id AS "userId", m.household_id AS "householdId", u.display_name AS "displayName",
            coalesce(s.morning, true) AS morning, to_char(coalesce(s.morning_at, '07:00'), 'HH24:MI') AS morning_at,
            coalesce(s.evening, true) AS evening, to_char(coalesce(s.evening_at, '22:00'), 'HH24:MI') AS evening_at
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN digest_settings s ON s.user_id = u.id
      WHERE m.status = 'active' AND u.disabled_at IS NULL
        AND EXISTS (SELECT 1 FROM auth_sessions a WHERE a.user_id = u.id)`,
  );
  let sent = 0;
  for (const p of people.rows) {
    for (const kind of ['morning', 'evening'] as const) {
      const enabled = kind === 'morning' ? p.morning : p.evening;
      const at = minutesOf(kind === 'morning' ? p.morning_at : p.evening_at);
      if (!enabled || clock.minutes < at || clock.minutes >= at + GRACE_MINUTES) continue;
      const claimed = await deps.db.owner.query(
        `INSERT INTO digest_runs (user_id, kind, day) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING RETURNING user_id`,
        [p.userId, kind, clock.date],
      );
      if (!claimed.rowCount) continue;
      try {
        const d = await buildDigest(deps, p, kind, now);
        await deliverDigest(deps, p, kind, clock.date, d);
        sent++;
      } catch {
        // Błąd (np. baza chwilowo niedostępna) — następna minuta spróbuje ponownie.
        await deps.db.owner.query(
          'DELETE FROM digest_runs WHERE user_id = $1 AND kind = $2 AND day = $3',
          [p.userId, kind, clock.date],
        );
      }
    }
  }
  return sent;
}

async function deliverDigest(
  deps: AppDeps,
  user: DigestUser,
  kind: DigestKind,
  date: string,
  d: Digest,
): Promise<void> {
  await withSystemTx(deps.db, async (c) => {
    const n = await c.query<{ id: string }>(
      `INSERT INTO notifications (household_id, user_id, kind, title, body, ref_type, ref_id, idempotency_key)
       VALUES ($1, $2, 'briefing', $3, $4, 'digest', $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [
        user.householdId,
        user.userId,
        d.title,
        d.body,
        kind,
        `digest:${kind}:${date}:${user.userId}`,
      ],
    );
    if (n.rows[0])
      await emitEvent(c, {
        householdId: user.householdId,
        ownerUserId: user.userId,
        visibility: 'private',
        type: 'notification.created',
        payload: { notificationId: n.rows[0].id, kind: 'briefing' },
      });
  });
}

/** Pętla w procesie API: sprawdzenie co minutę. */
export function startDigestScheduler(deps: AppDeps, everyMs = 60_000): () => void {
  let busy = false;
  const iv = setInterval(() => {
    if (busy) return;
    busy = true;
    void runDueDigests(deps)
      .catch(() => 0)
      .finally(() => {
        busy = false;
      });
  }, everyMs);
  return () => clearInterval(iv);
}
