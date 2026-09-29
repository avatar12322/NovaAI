import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { isUuid, requireAuth } from '../access';
import { withUserTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { forbidden, notFound } from '../lib/errors';
import { parse } from '../lib/validate';
import { listPantry, setById, stock } from './service';

/** Spiżarnia domu (lodówka, zamrażarka, szafka): stan, dodawanie, „jest”, „skończyło się”, usunięcie. */
const Add = z.object({ items: z.array(z.string().trim().min(1).max(120)).min(1).max(50) });

export const pantryRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const member = (req: FastifyRequest) => {
      const auth = requireAuth(req);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      return { userId: auth.userId, householdId: auth.householdId };
    };
    const asUser = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
      withUserTx(deps.db, { userId, scope: 'user' }, fn);

    app.get('/pantry', async (req) => {
      const m = member(req);
      return { items: await asUser(m.userId, (c) => listPantry(c, m.householdId, m.userId)) };
    });

    app.post('/pantry', async (req, reply) => {
      const m = member(req);
      const { items } = parse(Add, req.body);
      const added = await asUser(m.userId, (c) =>
        stock(c, m.householdId, m.userId, items, { learn: false }),
      );
      return reply.status(201).send({ added });
    });

    for (const action of ['have', 'gone'] as const) {
      app.post<{ Params: { id: string } }>(`/pantry/:id/${action}`, async (req) => {
        if (!isUuid(req.params.id)) throw notFound('Pozycja');
        const m = member(req);
        if (
          !(await asUser(m.userId, (c) =>
            setById(c, m.householdId, m.userId, req.params.id, action),
          ))
        )
          throw notFound('Pozycja');
        return { ok: true };
      });
    }

    app.delete<{ Params: { id: string } }>('/pantry/:id', async (req, reply) => {
      if (!isUuid(req.params.id)) throw notFound('Pozycja');
      const m = member(req);
      if (
        !(await asUser(m.userId, (c) =>
          setById(c, m.householdId, m.userId, req.params.id, 'remove'),
        ))
      )
        throw notFound('Pozycja');
      return reply.status(204).send();
    });
  };
