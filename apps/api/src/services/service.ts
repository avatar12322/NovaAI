import {
  parseAmountMicros,
  safePanelUrl,
  type BudgetState,
  type CostEntryInfo,
  type CostKind,
  type Money,
  type ServiceInfo,
  type ServiceMonth,
} from '@nova/contracts';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withSystemTx, type Db } from '../db/pool';
import { emitEvent } from '../events';
import { createReminder, MAX_AHEAD_MS, ReminderError } from '../reminders/service';

/**
 * „Usługi i koszty”. Suma miesiąca: w obrębie jednej usługi i jednego miesiąca liczy się JEDNO źródło —
 * faktura > raport dostawcy > szacunek (szacunek = wpisy ręczne + koszt zapisanych wywołań modeli). Dzięki temu
 * ta sama opłata nie jest liczona dwa razy, gdy po szacunku przyjdzie raport, a potem faktura. Waluty nie są
 * sumowane ani przeliczane — każda suma jest osobna dla waluty.
 */
export interface ServiceRow {
  id: string;
  household_id: string;
  owner_user_id: string;
  owner_name: string | null;
  visibility: 'private' | 'shared';
  name: string;
  category: ServiceInfo['category'];
  purpose: string;
  panel_url: string | null;
  billing_period: ServiceInfo['billingPeriod'];
  currency: string;
  plan: string;
  renews_on: string | null;
  renewal_anchor_day: number | null;
  remind_days_before: number;
  monthly_budget_micros: string | null;
  status: ServiceInfo['status'];
  model_provider: string | null;
  cost_adapter: ServiceInfo['costAdapter'];
  reminder_id: string | null;
  reminder_status: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
}

export const SERVICE_SELECT = `
  SELECT s.id, s.household_id, s.owner_user_id, u.display_name AS owner_name, s.visibility, s.name, s.category,
         s.purpose, s.panel_url, s.billing_period, s.currency, s.plan, to_char(s.renews_on, 'YYYY-MM-DD') AS renews_on,
         s.renewal_anchor_day, s.remind_days_before, s.monthly_budget_micros, s.status, s.model_provider,
         s.cost_adapter, s.reminder_id, r.status AS reminder_status, s.notes, s.created_at, s.updated_at
    FROM services s
    JOIN users u ON u.id = s.owner_user_id
    LEFT JOIN reminders r ON r.id = s.reminder_id`;

interface CostRow {
  id: string;
  service_id: string;
  kind: CostKind;
  month: string;
  amount_micros: string;
  currency: string;
  description: string;
  invoice_number: string | null;
  issued_on: string | null;
  paid_on: string | null;
  source: string;
  created_at: string;
}

const COST_SELECT = `
  SELECT id, service_id, kind, to_char(month, 'YYYY-MM') AS month, amount_micros, currency, description,
         invoice_number, to_char(issued_on, 'YYYY-MM-DD') AS issued_on, to_char(paid_on, 'YYYY-MM-DD') AS paid_on,
         source, created_at
    FROM service_costs`;

const RANK: Record<CostKind, number> = { estimate: 1, report: 2, invoice: 3 };

/** Najdokładniejsze źródło wśród wpisów jednego miesiąca. */
export function countedKind(kinds: Iterable<CostKind>): CostKind | null {
  let best: CostKind | null = null;
  for (const k of kinds) if (!best || RANK[k] > RANK[best]) best = k;
  return best;
}

function addMoney(list: Money[], currency: string, micros: number) {
  const m = list.find((x) => x.currency === currency);
  if (m) m.micros += micros;
  else list.push({ currency, micros });
}

const monthRange = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
};

function budgetState(budget: number, spent: number): BudgetState {
  if (spent > budget) return 'exceeded';
  if (spent >= budget * 0.8) return 'near';
  return 'ok';
}

/** Szacunki z usage_records (koszt wywołań modeli) per dom × dostawca × waluta w miesiącu (UTC). */
async function modelEstimates(
  c: pg.PoolClient,
  services: ServiceRow[],
  month: string,
): Promise<Map<string, Money[]>> {
  const linked = services.filter((s) => s.model_provider);
  const out = new Map<string, Money[]>();
  if (!linked.length) return out;
  const { from, to } = monthRange(month);
  const r = await c.query<{
    household_id: string;
    provider: string;
    currency: string;
    micros: string;
  }>(
    `SELECT household_id, provider, currency, sum(cost_micros)::bigint AS micros
       FROM usage_records
      WHERE household_id = ANY($1) AND provider = ANY($2) AND status <> 'failed' AND paid
        AND created_at >= $3 AND created_at < $4
      GROUP BY household_id, provider, currency`,
    [
      [...new Set(linked.map((s) => s.household_id))],
      [...new Set(linked.map((s) => s.model_provider!))],
      from,
      to,
    ],
  );
  for (const s of linked) {
    const rows = r.rows.filter(
      (x) => x.household_id === s.household_id && x.provider === s.model_provider,
    );
    const list: Money[] = [];
    for (const x of rows) if (Number(x.micros) > 0) addMoney(list, x.currency, Number(x.micros));
    out.set(s.id, list);
  }
  return out;
}

/** Stan miesiąca dla usług (wpisy odczytywane przez RLS — tylko widoczne usługi). */
export async function monthsFor(
  c: pg.PoolClient,
  services: ServiceRow[],
  month: string,
): Promise<Map<string, ServiceMonth & { invoiceUnpaid: Money[] }>> {
  const out = new Map<string, ServiceMonth & { invoiceUnpaid: Money[] }>();
  if (!services.length) return out;
  const costs = await c.query<CostRow>(
    `${COST_SELECT} WHERE service_id = ANY($1) AND month = $2::date`,
    [services.map((s) => s.id), `${month}-01`],
  );
  const estimates = await modelEstimates(c, services, month);
  for (const s of services) {
    const entries = costs.rows.filter((x) => x.service_id === s.id);
    const model = estimates.get(s.id) ?? [];
    const kinds = new Set<CostKind>(entries.map((e) => e.kind));
    if (model.length) kinds.add('estimate');
    const kind = countedKind(kinds);
    const totals: Money[] = [];
    const invoiceUnpaid: Money[] = [];
    for (const e of entries.filter((x) => x.kind === kind)) {
      addMoney(totals, e.currency, Number(e.amount_micros));
      if (e.kind === 'invoice' && !e.paid_on)
        addMoney(invoiceUnpaid, e.currency, Number(e.amount_micros));
    }
    if (kind === 'estimate') for (const m of model) addMoney(totals, m.currency, m.micros);
    // Najpierw waluta usługi, potem pozostałe alfabetycznie — stabilna kolejność w UI.
    totals.sort((a, b) =>
      a.currency === s.currency
        ? -1
        : b.currency === s.currency
          ? 1
          : a.currency.localeCompare(b.currency),
    );
    const budgetMicros = s.monthly_budget_micros === null ? null : Number(s.monthly_budget_micros);
    const spent = totals.find((t) => t.currency === s.currency)?.micros ?? 0;
    out.set(s.id, {
      month,
      countedKind: kind,
      totals,
      modelEstimate: model,
      budget:
        budgetMicros === null
          ? null
          : {
              micros: budgetMicros,
              currency: s.currency,
              spentMicros: spent,
              state: budgetState(budgetMicros, spent),
            },
      otherCurrencies: totals.map((t) => t.currency).filter((cur) => cur !== s.currency),
      invoiceUnpaid,
    });
  }
  return out;
}

export function toServiceInfo(s: ServiceRow, userId: string, current: ServiceMonth): ServiceInfo {
  return {
    id: s.id,
    name: s.name,
    category: s.category,
    purpose: s.purpose,
    panelUrl: s.panel_url,
    billingPeriod: s.billing_period,
    currency: s.currency,
    plan: s.plan,
    renewsOn: s.renews_on,
    remindDaysBefore: s.remind_days_before,
    reminderScheduled: s.reminder_status === 'scheduled',
    monthlyBudgetMicros: s.monthly_budget_micros === null ? null : Number(s.monthly_budget_micros),
    status: s.status,
    modelProvider: s.model_provider,
    costAdapter: s.cost_adapter,
    notes: s.notes,
    visibility: s.visibility,
    ownerUserId: s.owner_user_id,
    ownerName: s.owner_name,
    isMine: s.owner_user_id === userId,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    current: {
      month: current.month,
      countedKind: current.countedKind,
      totals: current.totals,
      modelEstimate: current.modelEstimate,
      budget: current.budget,
      otherCurrencies: current.otherCurrencies,
    },
  };
}

/** Wpisy usługi z oznaczeniem, które wchodzą do sumy swojego miesiąca. */
export async function entriesFor(c: pg.PoolClient, serviceId: string): Promise<CostEntryInfo[]> {
  const r = await c.query<CostRow>(
    `${COST_SELECT} WHERE service_id = $1 ORDER BY month DESC, created_at DESC LIMIT 500`,
    [serviceId],
  );
  const byMonth = new Map<string, Set<CostKind>>();
  for (const e of r.rows) {
    const set = byMonth.get(e.month) ?? new Set<CostKind>();
    set.add(e.kind);
    byMonth.set(e.month, set);
  }
  return r.rows.map((e) => ({
    id: e.id,
    kind: e.kind,
    month: e.month,
    amountMicros: Number(e.amount_micros),
    currency: e.currency,
    description: e.description,
    invoiceNumber: e.invoice_number,
    issuedOn: e.issued_on,
    paidOn: e.paid_on,
    source: e.source,
    counted: countedKind(byMonth.get(e.month) ?? []) === e.kind,
    createdAt: e.created_at,
  }));
}

// ---------- Deduplikacja ----------

const normNumber = (n: string) => n.toUpperCase().replace(/\s+/g, '');

export function dedupeKey(e: {
  kind: CostKind;
  invoiceNumber?: string | null;
  issuedOn?: string | null;
  month: string;
  amountMicros: number;
  currency: string;
}): string {
  if (e.kind !== 'invoice') return `manual:${randomUUID()}`;
  if (e.invoiceNumber) return `invoice:${normNumber(e.invoiceNumber)}`.slice(0, 200);
  return `invoice:${e.issuedOn ?? e.month}:${e.amountMicros}:${e.currency}`;
}

// ---------- Odnowienia ----------

const PERIOD_MONTHS: Partial<Record<ServiceInfo['billingPeriod'], number>> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

/** Następna data odnowienia z zachowaniem dnia miesiąca (31.01 → 28/29.02 → 31.03). */
export function nextRenewal(
  renewsOn: string,
  anchorDay: number,
  period: ServiceInfo['billingPeriod'],
): string | null {
  const months = PERIOD_MONTHS[period];
  if (!months) return null;
  const [y, m] = renewsOn.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + months;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  const dim = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(anchorDay, dim)).padStart(2, '0')}`;
}

function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return Math.round((local - at.getTime()) / 60_000);
}

const REMINDER_TZ = 'Europe/Warsaw';

/** Godzina 09:00 czasu polskiego w danym dniu (z uwzględnieniem czasu letniego). */
export function nineAmWarsaw(dateText: string): Date {
  const [y, m, d] = dateText.split('-').map(Number) as [number, number, number];
  const guess = new Date(Date.UTC(y, m - 1, d, 9, 0));
  return new Date(guess.getTime() - zoneOffsetMinutes(guess, REMINDER_TZ) * 60_000);
}

const minusDays = (dateText: string, days: number) =>
  new Date(Date.parse(`${dateText}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/**
 * Przypomnienie o odnowieniu: `remind_days_before` dni przed datą, 09:00 czasu polskiego. Poprzednie
 * przypomnienie jest anulowane. Widoczność jak usługi (wspólna usługa => przypomnienie dla domowników).
 * Zwraca ostrzeżenie, gdy przypomnienia nie da się ustawić.
 */
export async function syncReminder(c: pg.PoolClient, s: ServiceRow): Promise<string | null> {
  if (s.reminder_id) {
    await c.query(
      `UPDATE reminders SET status = 'cancelled', cancelled_at = now() WHERE id = $1 AND status = 'scheduled'`,
      [s.reminder_id],
    );
  }
  let reminderId: string | null = null;
  let warning: string | null = null;
  if (s.renews_on && s.status !== 'cancelled') {
    const renewal = nineAmWarsaw(s.renews_on);
    let due = nineAmWarsaw(minusDays(s.renews_on, s.remind_days_before));
    const now = Date.now();
    if (renewal.getTime() < now) {
      warning = 'Data odnowienia już minęła — oznacz usługę jako odnowioną albo zmień datę.';
    } else if (due.getTime() > now + MAX_AHEAD_MS) {
      warning =
        'Przypomnienie można ustawić najwyżej rok wcześniej — zaktualizuj datę bliżej terminu.';
    } else {
      if (due.getTime() < now + 60_000) due = new Date(now + 60_000);
      try {
        const r = await createReminder(c, {
          householdId: s.household_id,
          visibility: s.visibility,
          text: `Odnowienie: ${s.name}${s.plan ? ` (${s.plan})` : ''} — ${s.renews_on}`.slice(
            0,
            500,
          ),
          dueAt: due,
          source: 'service',
        });
        reminderId = r.id;
      } catch (e) {
        if (!(e instanceof ReminderError)) throw e;
        warning = `Nie ustawiono przypomnienia: ${e.message}`;
      }
    }
  }
  await c.query(`UPDATE services SET reminder_id = $2 WHERE id = $1`, [s.id, reminderId]);
  return warning;
}

// ---------- Budżet ----------

/**
 * Po zmianie wpisów: przekroczony budżet miesiąca => jedno powiadomienie na usługę i miesiąc
 * (klucz idempotencji), dla właściciela albo — przy usłudze wspólnej — dla domowników.
 */
export async function notifyBudget(
  db: Db,
  service: ServiceRow,
  state: ServiceMonth,
): Promise<boolean> {
  if (state.budget?.state !== 'exceeded') return false;
  return withSystemTx(db, async (c) => {
    const recipients =
      service.visibility === 'shared'
        ? (
            await c.query<{ user_id: string }>(
              `SELECT user_id FROM memberships WHERE household_id = $1 AND status = 'active'`,
              [service.household_id],
            )
          ).rows.map((r) => r.user_id)
        : [service.owner_user_id];
    let sent = false;
    for (const uid of recipients) {
      const n = await c.query<{ id: string }>(
        `INSERT INTO notifications (household_id, user_id, kind, title, body, ref_type, ref_id, idempotency_key)
         VALUES ($1, $2, 'budget', $3, $4, 'service', $5, $6)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [
          service.household_id,
          uid,
          `Przekroczono budżet: ${service.name}`,
          `Suma kosztów za ${state.month} przekracza miesięczny budżet usługi.`,
          service.id,
          `service-budget:${service.id}:${state.month}:${uid}`,
        ],
      );
      if (n.rows[0]) {
        sent = true;
        await emitEvent(c, {
          householdId: service.household_id,
          ownerUserId: uid,
          visibility: 'private',
          type: 'notification.created',
          payload: { notificationId: n.rows[0].id, kind: 'budget' },
        });
      }
    }
    return sent;
  });
}

// ---------- Import CSV ----------

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/ł/g, 'l')
    .trim();

interface ImportRow {
  line: number;
  invoiceNumber: string;
  issuedOn: string | null;
  amountMicros: number;
  currency: string;
  month: string;
  paidOn: string | null;
  description: string;
}

/**
 * CSV faktur: nagłówek `numer;data_wystawienia;kwota;waluta;miesiac;data_zaplaty[;opis]` (kolejność dowolna,
 * separator „;” albo „,”). Zwraca wiersze albo błędy z numerami linii — przy błędach nic nie jest importowane.
 */
export function parseInvoiceCsv(
  csv: string,
  validate: { currency: (c: string) => boolean; secret: (t: string) => boolean },
): { rows: ImportRow[]; errors: string[] } {
  const lines = csv
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const errors: string[] = [];
  if (lines.length < 2) return { rows: [], errors: ['Brak wierszy (wymagany nagłówek i dane)'] };
  if (lines.length > 501) return { rows: [], errors: ['Maksymalnie 500 faktur w jednym imporcie'] };
  const sep = lines[0]!.includes(';') ? ';' : ',';
  const head = lines[0]!.split(sep).map(norm);
  const col = (name: string) => head.indexOf(name);
  const need = ['numer', 'kwota', 'waluta', 'miesiac'];
  const missing = need.filter((n) => col(n) < 0);
  if (missing.length) return { rows: [], errors: [`Brak kolumn: ${missing.join(', ')}`] };
  const rows: ImportRow[] = [];
  const dateOk = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
  lines.slice(1).forEach((line, i) => {
    const n = i + 2;
    const cells = line.split(sep).map((x) => x.trim());
    const get = (name: string) => (col(name) >= 0 ? (cells[col(name)] ?? '') : '');
    const number = get('numer');
    const amount = parseAmountMicros(get('kwota'));
    const currency = get('waluta').toUpperCase();
    const month = get('miesiac');
    const issued = get('data_wystawienia');
    const paid = get('data_zaplaty');
    const description = get('opis').slice(0, 300);
    if (!number || number.length > 80) errors.push(`Linia ${n}: brak lub za długi numer faktury`);
    if (amount === null) errors.push(`Linia ${n}: nieprawidłowa kwota`);
    if (!validate.currency(currency)) errors.push(`Linia ${n}: nieznana waluta „${currency}”`);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
      errors.push(`Linia ${n}: miesiąc w formacie RRRR-MM`);
    if (issued && !dateOk(issued)) errors.push(`Linia ${n}: data wystawienia RRRR-MM-DD`);
    if (paid && !dateOk(paid)) errors.push(`Linia ${n}: data zapłaty RRRR-MM-DD`);
    if (validate.secret(line)) errors.push(`Linia ${n}: wygląda na hasło lub klucz — usuń je`);
    if (amount !== null)
      rows.push({
        line: n,
        invoiceNumber: number,
        issuedOn: issued || null,
        amountMicros: amount,
        currency,
        month,
        paidOn: paid || null,
        description,
      });
  });
  return { rows: errors.length ? [] : rows, errors: errors.slice(0, 20) };
}

/** Walidacja pól serwisu po stronie serwera (niezależnie od schematu). */
export function panelUrlOrNull(url: string | null | undefined): string | null {
  if (!url) return null;
  return safePanelUrl(url);
}
