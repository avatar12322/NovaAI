import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUuid, requireAuth } from '../access';
import { withUserTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { warsawClock } from '../digest/service';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { parse } from '../lib/validate';
import {
  addExpense,
  addPayment,
  CATEGORIES,
  CATEGORY_KEYS,
  deleteExpense,
  endPayment,
  listExpenses,
  listPayments,
  markPaid,
  monthEnd,
} from './service';

/** Wydatki (wspólne i prywatne), stałe płatności i raty — każdy domownik dla siebie i dla domu. */
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Miesiąc w formacie RRRR-MM');
const DateStr = z.iso.date();
const Currency = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .default('PLN');
const Amount = z.number().positive().max(9_999_999.99);
const SpaceP = z.enum(['private', 'shared']);

const NewExpense = z.object({
  amount: Amount,
  currency: Currency,
  category: z.enum(CATEGORY_KEYS),
  description: z.string().trim().max(200).default(''),
  spentOn: DateStr,
  space: SpaceP,
});
const NewPayment = z.object({
  name: z.string().trim().min(1).max(120),
  amount: Amount,
  currency: Currency,
  category: z.enum(CATEGORY_KEYS).default('raty'),
  dayOfMonth: z.number().int().min(1).max(31),
  /** Ostatnia płatność (miesiąc); brak — bez końca. */
  lastMonth: Month.nullable().default(null),
  space: SpaceP,
});
const ListQuery = z.object({
  month: Month.optional(),
  space: z.enum(['all', 'private', 'shared']).default('all'),
});
const PaidBody = z.object({ month: Month.optional(), amount: Amount.optional() });

export const expenseRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const member = (req: FastifyRequest) => {
      const auth = requireAuth(req);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      return { userId: auth.userId, householdId: auth.householdId };
    };
    const asUser = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
      withUserTx(deps.db, { userId, scope: 'user' }, fn);
    const today = () => warsawClock(new Date()).date;

    app.get('/expenses/categories', async () => ({
      categories: CATEGORY_KEYS.map((key) => ({ key, label: CATEGORIES[key] })),
    }));

    app.get('/expenses', async (req) => {
      const m = member(req);
      const q = parse(ListQuery, req.query);
      const month = q.month ?? today().slice(0, 7);
      return {
        month,
        ...(await asUser(m.userId, (c) => listExpenses(c, m.householdId, month, q.space))),
      };
    });

    app.post('/expenses', async (req, reply) => {
      const m = member(req);
      const b = parse(NewExpense, req.body);
      if (b.spentOn > today()) throw badRequest('Data wydatku nie może być z przyszłości');
      const e = await asUser(m.userId, (c) =>
        addExpense(c, {
          householdId: m.householdId,
          visibility: b.space,
          amount: b.amount,
          currency: b.currency,
          category: b.category,
          description: b.description,
          spentOn: b.spentOn,
          source: 'manual',
        }),
      );
      return reply.status(201).send({ expense: e });
    });

    app.delete<{ Params: { id: string } }>('/expenses/:id', async (req, reply) => {
      const m = member(req);
      if (!isUuid(req.params.id)) throw notFound('Wydatek');
      if (!(await asUser(m.userId, (c) => deleteExpense(c, req.params.id))))
        throw notFound('Wydatek');
      return reply.status(204).send();
    });

    app.get('/payments', async (req) => {
      const m = member(req);
      const month = parse(z.object({ month: Month.optional() }), req.query).month;
      const mo = month ?? today().slice(0, 7);
      return {
        month: mo,
        items: await asUser(m.userId, (c) => listPayments(c, m.householdId, mo)),
      };
    });

    app.post('/payments', async (req, reply) => {
      const m = member(req);
      const b = parse(NewPayment, req.body);
      const startsOn = today();
      if (b.lastMonth && b.lastMonth < startsOn.slice(0, 7))
        throw badRequest('Ostatnia płatność nie może być w przeszłości');
      const id = await asUser(m.userId, (c) =>
        addPayment(c, {
          householdId: m.householdId,
          visibility: b.space,
          name: b.name,
          amount: b.amount,
          currency: b.currency,
          category: b.category,
          dayOfMonth: b.dayOfMonth,
          startsOn,
          endsOn: b.lastMonth ? monthEnd(b.lastMonth) : null,
        }),
      );
      return reply.status(201).send({ id });
    });

    app.post<{ Params: { id: string } }>('/payments/:id/paid', async (req) => {
      const m = member(req);
      if (!isUuid(req.params.id)) throw notFound('Płatność');
      const b = parse(PaidBody, req.body ?? {});
      const month = b.month ?? today().slice(0, 7);
      const r = await asUser(m.userId, (c) => markPaid(c, req.params.id, month, b.amount));
      if (!r) throw notFound('Płatność');
      return { paid: true, already: r.already, expense: r.expense };
    });

    // Zakończenie (spłacona rata, rezygnacja) — tylko autor.
    app.delete<{ Params: { id: string } }>('/payments/:id', async (req, reply) => {
      const m = member(req);
      if (!isUuid(req.params.id)) throw notFound('Płatność');
      if (!(await asUser(m.userId, (c) => endPayment(c, req.params.id))))
        throw notFound('Płatność');
      return reply.status(204).send();
    });
  };
