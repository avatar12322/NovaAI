import type pg from 'pg';

/**
 * Wydatki (wspólne domu i prywatne) oraz stałe płatności i raty. Wszystko w transakcji użytkownika (RLS):
 * widać własne prywatne i wspólne domu; zmienia i usuwa tylko autor. Kwoty w walucie wpisu (bez przeliczeń).
 */
export const CATEGORIES = {
  jedzenie: 'Jedzenie i zakupy',
  dom: 'Dom',
  rachunki: 'Rachunki i abonamenty',
  raty: 'Raty i kredyty',
  transport: 'Transport',
  zdrowie: 'Zdrowie',
  rozrywka: 'Rozrywka',
  ubrania: 'Ubrania',
  praca: 'Praca',
  inne: 'Inne',
} as const;
export type Category = keyof typeof CATEGORIES;
export const CATEGORY_KEYS = Object.keys(CATEGORIES) as [Category, ...Category[]];

export type Space = 'private' | 'shared';

export interface Expense {
  id: string;
  amount: number;
  currency: string;
  category: string;
  description: string;
  spentOn: string;
  visibility: Space;
  isMine: boolean;
  ownerUserId: string;
  source: string;
  paymentId: string | null;
}

export interface Payment {
  id: string;
  name: string;
  amount: number;
  currency: string;
  category: string;
  dayOfMonth: number;
  startsOn: string;
  endsOn: string | null;
  visibility: Space;
  isMine: boolean;
  /** Termin w bieżącym miesiącu (albo null — w tym miesiącu nie przypada). */
  dueDate: string | null;
  paid: boolean;
  /** Pozostałe płatności łącznie z bieżącym miesiącem (null — bez końca). */
  remaining: number | null;
  /** Najbliższy niezapłacony termin: w tym miesiącu albo w kolejnym (null — wszystkie raty minęły). */
  nextDueDate: string | null;
}

/** Miesiąc „RRRR-MM” → pierwszy i następny dzień miesiąca. */
export function monthRange(month: string): { from: string; to: string } {
  return { from: `${month}-01`, to: `${nextMonth(month)}-01` };
}

/** Dzień płatności w danym miesiącu (31 w lutym → ostatni dzień lutego). */
export function dueDateIn(month: string, dayOfMonth: number): string {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return `${month}-${String(Math.min(dayOfMonth, last)).padStart(2, '0')}`;
}

export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y! + 1}-01` : `${y}-${String(m! + 1).padStart(2, '0')}`;
}

/** Pierwszy termin płatności w dniu `from` albo później (np. pierwsza rata płatności dodanej dziś). */
export function dueOnOrAfter(from: string, dayOfMonth: number): string {
  const d = dueDateIn(from.slice(0, 7), dayOfMonth);
  return d >= from ? d : dueDateIn(nextMonth(from.slice(0, 7)), dayOfMonth);
}

/** Ostatni dzień miesiąca „RRRR-MM” (ostatnia rata w tym miesiącu). */
export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y!, m!, 0)).getUTCDate()).padStart(2, '0')}`;
}

/** Pozostałe (niezapłacone) płatności od bieżącego miesiąca do ostatniego włącznie. */
function remainingFrom(
  month: string,
  endMonth: string,
  inRange: (m: string) => boolean,
  paidNow: boolean,
): number {
  let n = 0;
  for (let m = month, i = 0; m <= endMonth && i < 600; m = nextMonth(m), i++) if (inRange(m)) n++;
  return Math.max(0, n - (paidNow && inRange(month) ? 1 : 0));
}

interface ExpenseRow {
  id: string;
  amount: string;
  currency: string;
  category: string;
  description: string;
  spent_on: string;
  visibility: Space;
  owner_user_id: string;
  mine: boolean;
  source: string;
  payment_id: string | null;
}

const toExpense = (r: ExpenseRow): Expense => ({
  id: r.id,
  amount: Number(r.amount),
  currency: r.currency,
  category: r.category,
  description: r.description,
  spentOn: r.spent_on,
  visibility: r.visibility,
  isMine: r.mine,
  ownerUserId: r.owner_user_id,
  source: r.source,
  paymentId: r.payment_id,
});

const spaceFilter = (space: Space | 'all') =>
  space === 'shared'
    ? `AND e.visibility = 'shared'`
    : space === 'private'
      ? `AND e.visibility = 'private'`
      : '';

export async function listExpenses(
  c: pg.PoolClient,
  householdId: string,
  month: string,
  space: Space | 'all',
): Promise<{
  items: Expense[];
  totals: Array<{ currency: string; total: number }>;
  byCategory: Array<{ category: string; currency: string; total: number }>;
}> {
  const { from, to } = monthRange(month);
  const where = `e.household_id = $1 AND e.spent_on >= $2 AND e.spent_on < $3 ${spaceFilter(space)}`;
  const items = await c.query<ExpenseRow>(
    `SELECT e.id, e.amount, e.currency, e.category, e.description, to_char(e.spent_on, 'YYYY-MM-DD') AS spent_on,
            e.visibility, e.owner_user_id, e.owner_user_id = nova_uid() AS mine, e.source, e.payment_id
       FROM expenses e WHERE ${where}
      ORDER BY e.spent_on DESC, e.created_at DESC LIMIT 500`,
    [householdId, from, to],
  );
  const totals = await c.query<{ currency: string; total: string }>(
    `SELECT e.currency, sum(e.amount) AS total FROM expenses e WHERE ${where}
      GROUP BY e.currency ORDER BY e.currency`,
    [householdId, from, to],
  );
  const byCategory = await c.query<{ category: string; currency: string; total: string }>(
    `SELECT e.category, e.currency, sum(e.amount) AS total FROM expenses e WHERE ${where}
      GROUP BY e.category, e.currency ORDER BY sum(e.amount) DESC`,
    [householdId, from, to],
  );
  return {
    items: items.rows.map(toExpense),
    totals: totals.rows.map((x) => ({ currency: x.currency, total: Number(x.total) })),
    byCategory: byCategory.rows.map((x) => ({
      category: x.category,
      currency: x.currency,
      total: Number(x.total),
    })),
  };
}

export interface NewExpense {
  householdId: string;
  visibility: Space;
  amount: number;
  currency: string;
  category: Category;
  description: string;
  spentOn: string;
  source: 'manual' | 'assistant' | 'payment';
}

export async function addExpense(c: pg.PoolClient, e: NewExpense): Promise<Expense> {
  const r = await c.query<ExpenseRow>(
    `INSERT INTO expenses (household_id, owner_user_id, visibility, amount, currency, category, description, spent_on, source)
     VALUES ($1, nova_uid(), $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, amount, currency, category, description, to_char(spent_on, 'YYYY-MM-DD') AS spent_on,
               visibility, owner_user_id, true AS mine, source, payment_id`,
    [
      e.householdId,
      e.visibility,
      e.amount.toFixed(2),
      e.currency,
      e.category,
      e.description,
      e.spentOn,
      e.source,
    ],
  );
  return toExpense(r.rows[0]!);
}

export async function deleteExpense(c: pg.PoolClient, id: string): Promise<boolean> {
  const r = await c.query('DELETE FROM expenses WHERE id = $1 AND owner_user_id = nova_uid()', [
    id,
  ]);
  return (r.rowCount ?? 0) > 0;
}

interface PaymentRow {
  id: string;
  name: string;
  amount: string;
  currency: string;
  category: string;
  day_of_month: number;
  starts_on: string;
  ends_on: string | null;
  visibility: Space;
  mine: boolean;
  paid: boolean;
}

/** Stałe płatności i raty (aktywne) ze stanem w danym miesiącu. */
export async function listPayments(
  c: pg.PoolClient,
  householdId: string,
  month: string,
): Promise<Payment[]> {
  const r = await c.query<PaymentRow>(
    `SELECT p.id, p.name, p.amount, p.currency, p.category, p.day_of_month,
            to_char(p.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(p.ends_on, 'YYYY-MM-DD') AS ends_on,
            p.visibility, p.owner_user_id = nova_uid() AS mine,
            EXISTS (SELECT 1 FROM expenses e WHERE e.payment_id = p.id AND e.payment_month = $2::date) AS paid
       FROM recurring_payments p
      WHERE p.household_id = $1 AND p.active
      ORDER BY p.day_of_month, p.name`,
    [householdId, `${month}-01`],
  );
  return r.rows.map((p) => {
    const inRange = (m: string) => {
      const d = dueDateIn(m, p.day_of_month);
      return d >= p.starts_on && (!p.ends_on || d <= p.ends_on);
    };
    const due = dueDateIn(month, p.day_of_month);
    const next = [month, nextMonth(month)].find((m) => inRange(m) && !(m === month && p.paid));
    return {
      id: p.id,
      name: p.name,
      amount: Number(p.amount),
      currency: p.currency,
      category: p.category,
      dayOfMonth: p.day_of_month,
      startsOn: p.starts_on,
      endsOn: p.ends_on,
      visibility: p.visibility,
      isMine: p.mine,
      dueDate: inRange(month) ? due : null,
      paid: p.paid,
      remaining: p.ends_on ? remainingFrom(month, p.ends_on.slice(0, 7), inRange, p.paid) : null,
      nextDueDate: next ? dueDateIn(next, p.day_of_month) : null,
    };
  });
}

export interface NewPayment {
  householdId: string;
  visibility: Space;
  name: string;
  amount: number;
  currency: string;
  category: Category;
  dayOfMonth: number;
  startsOn: string;
  endsOn: string | null;
}

export async function addPayment(c: pg.PoolClient, p: NewPayment): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO recurring_payments (household_id, owner_user_id, visibility, name, amount, currency, category,
       day_of_month, starts_on, ends_on)
     VALUES ($1, nova_uid(), $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      p.householdId,
      p.visibility,
      p.name,
      p.amount.toFixed(2),
      p.currency,
      p.category,
      p.dayOfMonth,
      p.startsOn,
      p.endsOn,
    ],
  );
  return r.rows[0]!.id;
}

/** Zakończenie płatności (np. spłacony kredyt) — znika z listy; zapłacone raty zostają w wydatkach. */
export async function endPayment(c: pg.PoolClient, id: string): Promise<boolean> {
  const r = await c.query(
    `UPDATE recurring_payments SET active = false WHERE id = $1 AND owner_user_id = nova_uid() AND active`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * „Zapłacone” w danym miesiącu: wydatek z kwotą i kategorią płatności (widoczność jak płatność), raz na miesiąc.
 * `amount` — faktyczna kwota, gdy inna niż zapisana (np. rata o zmiennej wysokości).
 * Zwraca null, gdy płatność niewidoczna/nieaktywna; `already` — gdy miesiąc był już oznaczony.
 */
export async function markPaid(
  c: pg.PoolClient,
  paymentId: string,
  month: string,
  amount?: number,
): Promise<{ expense: Expense | null; already: boolean } | null> {
  const p = await c.query<{
    household_id: string;
    visibility: Space;
    name: string;
    amount: string;
    currency: string;
    category: string;
    day_of_month: number;
  }>(
    `SELECT household_id, visibility, name, amount, currency, category, day_of_month
       FROM recurring_payments WHERE id = $1 AND active`,
    [paymentId],
  );
  const pay = p.rows[0];
  if (!pay) return null;
  const r = await c.query<ExpenseRow>(
    `INSERT INTO expenses (household_id, owner_user_id, visibility, amount, currency, category, description,
       spent_on, source, payment_id, payment_month)
     VALUES ($1, nova_uid(), $2, $3, $4, $5, $6, $7, 'payment', $8, $9)
     ON CONFLICT (payment_id, payment_month) DO NOTHING
     RETURNING id, amount, currency, category, description, to_char(spent_on, 'YYYY-MM-DD') AS spent_on,
               visibility, owner_user_id, true AS mine, source, payment_id`,
    [
      pay.household_id,
      pay.visibility,
      amount !== undefined ? amount.toFixed(2) : pay.amount,
      pay.currency,
      pay.category,
      pay.name,
      dueDateIn(month, pay.day_of_month),
      paymentId,
      `${month}-01`,
    ],
  );
  return r.rows[0]
    ? { expense: toExpense(r.rows[0]), already: false }
    : { expense: null, already: true };
}

/** Niezapłacone płatności przypadające w danym dniu (do przeglądu dnia). */
export async function paymentsDueOn(
  c: pg.PoolClient,
  householdId: string,
  date: string,
): Promise<Payment[]> {
  const all = await listPayments(c, householdId, date.slice(0, 7));
  return all.filter((p) => p.dueDate === date && !p.paid);
}

const money = (v: number, currency: string) =>
  new Intl.NumberFormat('pl-PL', { style: 'currency', currency }).format(v);
export { money as formatMoney };
