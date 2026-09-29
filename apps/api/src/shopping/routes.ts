import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUuid, requireAuth } from '../access';
import { withUserTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { forbidden, notFound } from '../lib/errors';
import { parse } from '../lib/validate';
import { addItems, clearChecked, haveItem, listItems, removeItem, updateItem } from './service';

/** Wspólna lista zakupów: każdy domownik widzi, dodaje, odhacza i usuwa pozycje. */
const Add = z.object({ items: z.array(z.string().max(200)).min(1).max(50) });
const Patch = z
  .object({
    checked: z.boolean().optional(),
    text: z.string().trim().min(1).max(200).optional(),
    maybe: z.boolean().optional(),
  })
  .refine((p) => p.checked !== undefined || p.text !== undefined || p.maybe !== undefined, {
    message: 'brak zmian',
  });

export const shoppingRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const member = (req: FastifyRequest) => {
      const auth = requireAuth(req);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      return { userId: auth.userId, householdId: auth.householdId };
    };
    const asUser = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
      withUserTx(deps.db, { userId, scope: 'user' }, fn);

    app.get('/shopping', async (req) => {
      const m = member(req);
      return { items: await asUser(m.userId, (c) => listItems(c, m.householdId)) };
    });

    app.post('/shopping', async (req, reply) => {
      const m = member(req);
      const { items } = parse(Add, req.body);
      const r = await asUser(m.userId, (c) => addItems(c, m.householdId, m.userId, items));
      return reply.status(201).send(r);
    });

    app.patch<{ Params: { id: string } }>('/shopping/:id', async (req) => {
      if (!isUuid(req.params.id)) throw notFound('Pozycja');
      const body = parse(Patch, req.body);
      const m = member(req);
      const ok = await asUser(m.userId, (c) =>
        updateItem(c, m.householdId, m.userId, req.params.id, body),
      );
      if (!ok) throw notFound('Pozycja');
      return { ok: true };
    });

    app.delete<{ Params: { id: string } }>('/shopping/:id', async (req, reply) => {
      if (!isUuid(req.params.id)) throw notFound('Pozycja');
      const m = member(req);
      const ok = await asUser(m.userId, (c) =>
        removeItem(c, m.householdId, m.userId, req.params.id),
      );
      if (!ok) throw notFound('Pozycja');
      return reply.status(204).send();
    });

    // „Mam” przy pozycji „pewnie masz”: usunięcie z listy i zapis w spiżarni.
    app.post<{ Params: { id: string } }>('/shopping/:id/have', async (req) => {
      if (!isUuid(req.params.id)) throw notFound('Pozycja');
      const m = member(req);
      if (!(await asUser(m.userId, (c) => haveItem(c, m.householdId, m.userId, req.params.id))))
        throw notFound('Pozycja');
      return { ok: true };
    });

    app.post('/shopping/clear-checked', async (req) => {
      const m = member(req);
      return { removed: await asUser(m.userId, (c) => clearChecked(c, m.householdId, m.userId)) };
    });
  };
