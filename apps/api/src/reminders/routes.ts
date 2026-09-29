import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { isUuid, requireAuth } from '../access';
import { writeAudit } from '../audit';
import { withSystemTx, withUserTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { forbidden, HttpError, notFound } from '../lib/errors';
import { parse } from '../lib/validate';
import { cancelReminder, createReminder, ReminderError } from './service';

const CreateReminder = z.object({
  text: z.string().trim().min(1).max(500),
  dueAt: z.iso.datetime({ offset: true }),
  space: z.enum(['private', 'shared']).default('private'),
});
const ListQuery = z.object({ space: z.enum(['private', 'shared']).default('private') });

interface Row {
  id: string;
  visibility: 'private' | 'shared';
  text: string;
  due_at: string;
  status: string;
  owner_user_id: string;
  owner_name: string;
  created_at: string;
  fired_at: string | null;
}

export const reminderRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get('/reminders', async (req) => {
      const auth = requireAuth(req);
      const q = parse(ListQuery, req.query);
      const rows = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, async (c) => {
        const r = await c.query<Row>(
          `SELECT r.id, r.visibility, r.text, r.due_at, r.status, r.owner_user_id, u.display_name AS owner_name, r.created_at, r.fired_at
             FROM reminders r JOIN users u ON u.id = r.owner_user_id
            WHERE r.visibility = $1 AND ($1 = 'shared' OR r.owner_user_id = nova_uid())
              AND (r.status = 'scheduled' OR r.due_at > now() - interval '7 days')
            ORDER BY r.due_at LIMIT 100`,
          [q.space],
        );
        return r.rows;
      });
      return {
        items: rows.map((r) => ({
          id: r.id,
          visibility: r.visibility,
          text: r.text,
          dueAt: r.due_at,
          status: r.status,
          isMine: r.owner_user_id === auth.userId,
          ownerName: r.owner_name,
          firedAt: r.fired_at,
        })),
      };
    });

    app.post('/reminders', async (req, reply) => {
      const auth = requireAuth(req);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      const body = parse(CreateReminder, req.body);
      try {
        const r = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, (c) =>
          createReminder(c, {
            householdId: auth.householdId!,
            visibility: body.space,
            text: body.text,
            dueAt: new Date(body.dueAt),
            source: 'user',
            requestId: req.id,
          }),
        );
        await writeAudit(deps.db, {
          actorKind: 'user',
          actorUserId: auth.userId,
          ownerUserId: auth.userId,
          householdId: auth.householdId,
          source: 'api',
          action: 'reminder.create',
          resourceType: 'reminder',
          resourceId: r.id,
          outcome: 'ok',
          correlationId: req.id,
          details: { visibility: body.space },
        });
        deps.kickQueue();
        return reply.status(201).send({ id: r.id });
      } catch (e) {
        if (e instanceof ReminderError) throw new HttpError(400, e.code, e.message);
        throw e;
      }
    });

    /** Anulowanie: tylko właściciel; zadanie dostarczenia jest anulowane w tej samej transakcji. */
    app.delete<{ Params: { id: string } }>('/reminders/:id', async (req, reply) => {
      const auth = requireAuth(req);
      if (!isUuid(req.params.id)) throw notFound('Reminder');
      const ok = await withSystemTx(deps.db, (c) => cancelReminder(c, req.params.id, auth.userId));
      if (!ok) throw notFound('Reminder');
      return reply.status(204).send();
    });
  };
