import type { Briefing } from '@nova/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../access';
import { withUserTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { forbidden } from '../lib/errors';

/**
 * Poranny przegląd: przypomnienia i wydarzenia na dziś, zgody, zadania, wiadomości, odnowienia usług i koszt
 * modeli. Wszystko przez RLS użytkownika (zakres „user”: własne prywatne + wspólne) — nic ponad to, co widać
 * w pozostałych widokach. Bez wywołań modelu i bez kosztów.
 */
const TZ = 'Europe/Warsaw';
const DAY = `date_trunc('day', now() AT TIME ZONE '${TZ}')`;
const DAY_START = `(${DAY} AT TIME ZONE '${TZ}')`;
const DAY_END = `((${DAY} + interval '1 day') AT TIME ZONE '${TZ}')`;

/** Polska odmiana: 1 zadanie, 2–4 zadania, 5+ zadań (12–14 zadań). */
export function plural(n: number, one: string, few: string, many: string): string {
  const tens = n % 100;
  const units = n % 10;
  const w = n === 1 ? one : units >= 2 && units <= 4 && (tens < 12 || tens > 14) ? few : many;
  return `${n} ${w}`;
}

const time = (iso: string) =>
  new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: TZ }).format(
    new Date(iso),
  );
const money = (v: number, currency: string) =>
  new Intl.NumberFormat('pl-PL', { style: 'currency', currency }).format(v);
const firstName = (displayName: string) => displayName.replace(/\s*\(.*\)\s*$/, '').trim();

export function briefingSummary(b: Omit<Briefing, 'summary'>): string {
  const parts: string[] = [`${b.greeting}. Dziś ${b.dateLabel}.`];
  if (b.events.length)
    parts.push(
      `W kalendarzu: ${b.events.map((e) => `${time(e.startsAt)} ${e.title}`).join(', ')}.`,
    );
  if (b.reminders.length)
    parts.push(
      `Przypomnienia: ${b.reminders.map((r) => `${r.text} o ${time(r.dueAt)}`).join(', ')}.`,
    );
  if (b.approvals)
    parts.push(
      `${plural(b.approvals, 'akcja czeka', 'akcje czekają', 'akcji czeka')} na Twoją zgodę.`,
    );
  if (b.activeTasks) parts.push(`${plural(b.activeTasks, 'zadanie', 'zadania', 'zadań')} w toku.`);
  if (b.unread)
    parts.push(
      `Masz ${plural(b.unread, 'nieprzeczytaną wiadomość', 'nieprzeczytane wiadomości', 'nieprzeczytanych wiadomości')}.`,
    );
  if (b.renewals.length)
    parts.push(
      `Wkrótce odnowienie: ${b.renewals
        .map(
          (r) =>
            `${r.name} (${r.daysLeft === 0 ? 'dziś' : r.daysLeft === 1 ? 'jutro' : `za ${r.daysLeft} dni`})`,
        )
        .join(', ')}.`,
    );
  if (b.budget.spent > 0 || b.budget.hardLimit !== null)
    parts.push(
      `Koszt modeli w tym miesiącu: ${money(b.budget.spent, b.budget.currency)}${
        b.budget.hardLimit !== null
          ? ` z limitu ${money(b.budget.hardLimit, b.budget.currency)}`
          : ''
      }.`,
    );
  if (parts.length === 1) parts.push('Nic pilnego — spokojny dzień.');
  return parts.join(' ');
}

export const briefingRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get('/briefing', async (req): Promise<Briefing> => {
      const auth = requireAuth(req);
      const hh = auth.householdId;
      if (!hh) throw forbidden('Brak aktywnego członkostwa w domu');
      const data = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, async (c) => {
        const day = await c.query<{ date: string; hour: number }>(
          `SELECT to_char(${DAY}, 'YYYY-MM-DD') AS date,
                  extract(hour FROM now() AT TIME ZONE '${TZ}')::int AS hour`,
        );
        const reminders = await c.query<{
          id: string;
          text: string;
          due_at: string;
          visibility: string;
        }>(
          `SELECT id, text, due_at, visibility FROM reminders
            WHERE household_id = $1 AND status = 'scheduled' AND due_at < ${DAY_END}
              AND (visibility = 'shared' OR owner_user_id = nova_uid())
            ORDER BY due_at LIMIT 10`,
          [hh],
        );
        const events = await c.query<{
          id: string;
          title: string;
          starts_at: string;
          ends_at: string;
        }>(
          `SELECT id, title, starts_at, ends_at FROM local_calendar_events
            WHERE owner_user_id = nova_uid() AND starts_at < ${DAY_END} AND ends_at > ${DAY_START}
            ORDER BY starts_at LIMIT 10`,
        );
        const counts = await c.query<{ approvals: number; tasks: number; unread: number }>(
          `SELECT
             (SELECT count(*) FROM approvals WHERE owner_user_id = nova_uid() AND status = 'pending'
                AND expires_at > now())::int AS approvals,
             (SELECT count(*) FROM tasks WHERE owner_user_id = nova_uid()
                AND status IN ('queued', 'running', 'waiting_approval') AND kind <> 'reminder.fire')::int AS tasks,
             (SELECT count(*) FROM notifications WHERE user_id = nova_uid() AND read_at IS NULL)::int AS unread`,
        );
        const renewals = await c.query<{
          id: string;
          name: string;
          renews_on: string;
          days: number;
        }>(
          `SELECT id, name, to_char(renews_on, 'YYYY-MM-DD') AS renews_on,
                  (renews_on - ${DAY}::date)::int AS days
             FROM services
            WHERE household_id = $1 AND status IN ('active', 'trial') AND renews_on IS NOT NULL
              AND renews_on BETWEEN ${DAY}::date AND ${DAY}::date + 7
              AND (visibility = 'shared' OR owner_user_id = nova_uid())
            ORDER BY renews_on, name LIMIT 10`,
          [hh],
        );
        return { day: day.rows[0]!, reminders, events, counts: counts.rows[0]!, renewals };
      });
      const budget = await deps.gateway.budget.status(hh);
      const b: Omit<Briefing, 'summary'> = {
        greeting: `${data.day.hour >= 18 || data.day.hour < 4 ? 'Dobry wieczór' : 'Dzień dobry'}, ${firstName(auth.displayName)}`,
        date: data.day.date,
        dateLabel: new Intl.DateTimeFormat('pl-PL', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          timeZone: TZ,
        }).format(new Date()),
        reminders: data.reminders.rows.map((r) => ({
          id: r.id,
          text: r.text,
          dueAt: r.due_at,
          shared: r.visibility === 'shared',
        })),
        events: data.events.rows.map((e) => ({
          id: e.id,
          title: e.title,
          startsAt: e.starts_at,
          endsAt: e.ends_at,
        })),
        approvals: data.counts.approvals,
        activeTasks: data.counts.tasks,
        unread: data.counts.unread,
        renewals: data.renewals.rows.map((r) => ({
          serviceId: r.id,
          name: r.name,
          renewsOn: r.renews_on,
          daysLeft: r.days,
        })),
        budget: {
          spent: budget.spent,
          hardLimit: budget.hardLimit,
          currency: budget.currency,
          state: budget.state,
        },
      };
      return { ...b, summary: briefingSummary(b) };
    });
  };
