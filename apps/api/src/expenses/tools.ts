import { z } from 'zod';
import { withUserTx } from '../db/pool';
import { warsawClock } from '../digest/service';
import { ToolDenied, type ToolContext, type ToolDef } from '../tools/types';
import {
  addExpense,
  addPayment,
  CATEGORIES,
  CATEGORY_KEYS,
  dueOnOrAfter,
  formatMoney,
  listExpenses,
  listPayments,
  markPaid,
  monthEnd,
} from './service';

/**
 * Wydatki i raty przez asystenta: „dodaj ten paragon do wydatków wspólnych” (zdjęcie → kwota, sklep, data),
 * „ile wydaliśmy w tym miesiącu?”, „dodaj ratę 450 zł 10-go do grudnia 2027”, „zapłaciłem ratę za telefon”.
 * W NovaAI (rozmowa wspólna) — tylko wspólne. Tura ze zdjęciem wymaga zgody (kwotę widać przed zapisem).
 */
const sharedOnly = (ctx: ToolContext) => ctx.context === 'household_agent';
const space = (ctx: ToolContext, shared: boolean) =>
  sharedOnly(ctx) || shared ? 'shared' : 'private';
const today = () => warsawClock(new Date()).date;
const asUser = <T>(ctx: ToolContext, fn: Parameters<typeof withUserTx<T>>[2]) =>
  withUserTx(ctx.deps.db, { userId: ctx.principal.userId, scope: 'user' }, fn);
const allow = async () => ({ allow: true, reason: 'own_or_household' });
const dayLabel = (date: string) =>
  new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(
    new Date(`${date}T12:00:00Z`),
  );
const REMINDER_NOTE =
  'Przypomnienie co miesiąc w przeglądzie dnia: wieczorem dzień przed terminem i rano w dniu terminu, dopóki nie zostanie oznaczona jako zapłacona';

type AddParams = {
  amount: number;
  currency: string;
  category: (typeof CATEGORY_KEYS)[number];
  description: string;
  date?: string;
  shared: boolean;
};

export const expenseAddTool: ToolDef<AddParams> = {
  name: 'expense.add',
  capability: 'expense.add',
  title: `Zapisz wydatek (np. z paragonu na zdjęciu). Kategorie: ${CATEGORY_KEYS.join(', ')}. shared=true — wydatek wspólny domu, false — osobisty. Data RRRR-MM-DD (domyślnie dziś).`,
  contexts: ['private_agent', 'household_agent'],
  params: z.object({
    amount: z.number().positive().max(9_999_999.99),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default('PLN'),
    category: z.enum(CATEGORY_KEYS),
    description: z.string().trim().max(200).default(''),
    date: z.iso.date().optional(),
    shared: z.boolean().default(false),
  }) as unknown as z.ZodType<AddParams>,
  requiresApproval: () => false,
  async preview(ctx, p) {
    return {
      summary: `Wydatek ${formatMoney(p.amount, p.currency)} — ${p.description || CATEGORIES[p.category]}`,
      target: space(ctx, p.shared) === 'shared' ? 'wydatki wspólne' : 'Twoje wydatki',
      scope: p.date ?? 'dziś',
    };
  },
  authorize: allow,
  async execute(ctx, p) {
    const date = p.date ?? today();
    if (date > today()) throw new ToolDenied('future_date');
    const vis = space(ctx, p.shared);
    const e = await asUser(ctx, (c) =>
      addExpense(c, {
        householdId: ctx.householdId,
        visibility: vis,
        amount: p.amount,
        currency: p.currency,
        category: p.category,
        description: p.description,
        spentOn: date,
        source: 'assistant',
      }),
    );
    return {
      summary: `Zapisano wydatek ${vis === 'shared' ? 'wspólny' : 'osobisty'}: ${formatMoney(e.amount, e.currency)} — ${e.description || CATEGORIES[p.category]} (${e.spentOn})`,
      output: { expenseId: e.id },
    };
  },
};

export const expenseSummaryTool: ToolDef<{ month?: string; space: 'all' | 'private' | 'shared' }> =
  {
    name: 'expense.summary',
    capability: 'expense.read',
    title:
      'Podsumowanie wydatków w miesiącu (RRRR-MM, domyślnie bieżący): suma, kategorie, ostatnie pozycje. space: all | shared | private.',
    contexts: ['private_agent', 'household_agent'],
    readOnly: true,
    params: z.object({
      month: z
        .string()
        .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
        .optional(),
      space: z.enum(['all', 'private', 'shared']).default('all'),
    }) as unknown as z.ZodType<{ month?: string; space: 'all' | 'private' | 'shared' }>,
    requiresApproval: () => false,
    async preview(_ctx, p) {
      return {
        summary: `Wydatki ${p.month ?? 'w tym miesiącu'}`,
        target: 'wydatki',
        scope: 'odczyt',
      };
    },
    authorize: allow,
    async execute(ctx, p) {
      const month = p.month ?? today().slice(0, 7);
      const s = sharedOnly(ctx) ? 'shared' : p.space;
      const r = await asUser(ctx, (c) => listExpenses(c, ctx.householdId, month, s));
      const lines = [
        `Suma: ${r.totals.map((t) => formatMoney(t.total, t.currency)).join(' + ') || '0 zł'}`,
        ...r.byCategory.map(
          (x) =>
            `${CATEGORIES[x.category as keyof typeof CATEGORIES] ?? x.category}: ${formatMoney(x.total, x.currency)}`,
        ),
        ...r.items
          .slice(0, 15)
          .map(
            (e) =>
              `${e.spentOn} ${formatMoney(e.amount, e.currency)} ${e.description || CATEGORIES[e.category as keyof typeof CATEGORIES]}${e.visibility === 'shared' ? ' (wspólny)' : ''}`,
          ),
      ];
      return {
        summary: `Wydatki ${month} (${s === 'all' ? 'wszystkie' : s === 'shared' ? 'wspólne' : 'osobiste'})`,
        output: { lines },
      };
    },
  };

export const paymentListTool: ToolDef<Record<string, never>> = {
  name: 'payment.list',
  capability: 'expense.read',
  title: 'Stałe płatności i raty w tym miesiącu: termin, kwota, czy zapłacone, ile rat zostało',
  contexts: ['private_agent', 'household_agent'],
  readOnly: true,
  params: z.object({}) as unknown as z.ZodType<Record<string, never>>,
  requiresApproval: () => false,
  async preview() {
    return { summary: 'Raty i stałe płatności', target: 'płatności', scope: 'odczyt' };
  },
  authorize: allow,
  async execute(ctx) {
    const month = today().slice(0, 7);
    const items = (await asUser(ctx, (c) => listPayments(c, ctx.householdId, month))).filter(
      (p) => !sharedOnly(ctx) || p.visibility === 'shared',
    );
    return {
      summary: items.length ? `Płatności (${items.length})` : 'Brak stałych płatności',
      output: {
        lines: items.map(
          (p) =>
            `[${p.id}] ${p.name}: ${formatMoney(p.amount, p.currency)}, ${p.dayOfMonth}. dnia miesiąca, ${p.paid ? 'w tym miesiącu zapłacone' : p.dueDate ? `w tym miesiącu niezapłacone (termin ${p.dueDate})` : 'w tym miesiącu bez terminu'}, ${p.nextDueDate ? `najbliższy termin ${p.nextDueDate}` : 'wszystkie raty minęły'}${p.remaining !== null ? `, pozostało ${p.remaining}` : ''}${p.visibility === 'shared' ? ' (wspólna)' : ''}`,
        ),
      },
    };
  },
};

type PaymentParams = {
  name: string;
  amount: number;
  currency: string;
  dayOfMonth: number;
  lastMonth?: string;
  shared: boolean;
};

export const paymentAddTool: ToolDef<PaymentParams> = {
  name: 'payment.add',
  capability: 'expense.add',
  title: `Dodaj stałą płatność albo ratę: nazwa, kwota, dzień miesiąca; lastMonth RRRR-MM — ostatnia rata (brak = bez końca). ${REMINDER_NOTE} — nie dodawaj do niej reminder.create. Gdy kwota bywa różna, zapisz orientacyjną; faktyczną podaje się przy payment.paid.`,
  contexts: ['private_agent', 'household_agent'],
  params: z.object({
    name: z.string().trim().min(1).max(120),
    amount: z.number().positive().max(9_999_999.99),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default('PLN'),
    dayOfMonth: z.number().int().min(1).max(31),
    lastMonth: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional(),
    shared: z.boolean().default(false),
  }) as unknown as z.ZodType<PaymentParams>,
  requiresApproval: () => false,
  async preview(ctx, p) {
    return {
      summary: `Płatność ${p.name}: ${formatMoney(p.amount, p.currency)} (${p.dayOfMonth}. dnia miesiąca)`,
      target: space(ctx, p.shared) === 'shared' ? 'płatności wspólne' : 'Twoje płatności',
      scope: p.lastMonth ? `do ${p.lastMonth}` : 'bez końca',
    };
  },
  authorize: allow,
  async execute(ctx, p) {
    const now = today();
    if (p.lastMonth && p.lastMonth < now.slice(0, 7)) throw new ToolDenied('last_month_in_past');
    const id = await asUser(ctx, (c) =>
      addPayment(c, {
        householdId: ctx.householdId,
        visibility: space(ctx, p.shared),
        name: p.name,
        amount: p.amount,
        currency: p.currency,
        category: 'raty',
        dayOfMonth: p.dayOfMonth,
        startsOn: now,
        endsOn: p.lastMonth ? monthEnd(p.lastMonth) : null,
      }),
    );
    return {
      summary: `Dodano płatność: ${p.name} — ${formatMoney(p.amount, p.currency)}, ${p.dayOfMonth}. dnia miesiąca${p.lastMonth ? `, do ${p.lastMonth}` : ''}; pierwszy termin: ${dayLabel(dueOnOrAfter(now, p.dayOfMonth))}. ${REMINDER_NOTE}.`,
      output: { paymentId: id },
    };
  },
};

export const paymentPaidTool: ToolDef<{ paymentId: string; amount?: number }> = {
  name: 'payment.paid',
  capability: 'expense.add',
  title:
    'Oznacz stałą płatność/ratę jako zapłaconą w tym miesiącu (identyfikator z payment.list). amount — faktyczna kwota, gdy inna niż zapisana (np. „zapłaciłem ratę 162 zł”).',
  contexts: ['private_agent', 'household_agent'],
  params: z.object({
    paymentId: z.uuid(),
    amount: z.number().positive().max(9_999_999.99).optional(),
  }),
  requiresApproval: () => false,
  async preview(_ctx, p) {
    return {
      summary: p.amount ? `Zapłacona płatność (kwota ${p.amount})` : 'Zapłacona płatność',
      target: 'płatności',
      scope: p.paymentId,
    };
  },
  authorize: allow,
  async execute(ctx, p) {
    const r = await asUser(ctx, (c) => markPaid(c, p.paymentId, today().slice(0, 7), p.amount));
    if (!r) throw new ToolDenied('payment_not_found');
    return {
      summary: r.already
        ? 'Ta płatność była już oznaczona jako zapłacona w tym miesiącu'
        : `Zapłacone: ${r.expense!.description} — ${formatMoney(r.expense!.amount, r.expense!.currency)}`,
      output: { paid: true },
    };
  },
};

export const EXPENSE_TOOLS = [
  expenseAddTool,
  expenseSummaryTool,
  paymentListTool,
  paymentAddTool,
  paymentPaidTool,
];
