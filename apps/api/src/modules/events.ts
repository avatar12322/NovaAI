import { canSee } from '../live';
import { ListEventsQuery, type Notification, type NovaEvent } from '@nova/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { authorize, isUuid, requireAuth } from '../access';
import { resolveSession, SESSION_COOKIE } from '../auth/session';
import { withUserTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { emitEvent, EVENT_SELECT, toEvent } from '../events';
import { notFound } from '../lib/errors';
import { parse } from '../lib/validate';

const KEEPALIVE_MS = 15_000;
const SESSION_RECHECK_MS = 30_000;

export const eventRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const visibleEvents = async (userId: string, after: number, limit: number, taskId?: string) =>
      withUserTx(deps.db, { userId, scope: 'user' }, async (c) => {
        const params: unknown[] = [after, limit];
        let where = 'id > $1';
        if (taskId) {
          params.push(taskId);
          where += ' AND task_id = $3';
        }
        const r = await c.query(`${EVENT_SELECT} WHERE ${where} ORDER BY id LIMIT $2`, params);
        return r.rows.map(toEvent);
      });

    /** Odpytywanie (fallback offline/po wznowieniu). */
    app.get('/events', async (req) => {
      const auth = requireAuth(req);
      const q = parse(ListEventsQuery, req.query);
      if (q.taskId) await authorize(deps.db, req, 'task', q.taskId, 'task.read');
      const items = await visibleEvents(auth.userId, q.after, q.limit, q.taskId);
      return { items, lastId: items.length ? items[items.length - 1]!.id : q.after };
    });

    /**
     * Strumień SSE. Z bazy (NOTIFY) przychodzi tylko ID zdarzenia; każde zdarzenie jest pobierane
     * ponownie w kontekście RLS odbiorcy, więc cudze prywatne zdarzenia nigdy nie trafiają do strumienia.
     */
    app.get('/events/stream', async (req, reply) => {
      const auth = requireAuth(req);
      const lastHeader = req.headers['last-event-id'];
      const q = parse(ListEventsQuery, req.query);
      const resumeFrom = Math.max(
        q.after,
        typeof lastHeader === 'string' && /^\d+$/.test(lastHeader) ? Number(lastHeader) : 0,
      );
      // Nowe połączenie (bez Last-Event-ID/after) zaczyna od bieżącego końca strumienia —
      // klient ładuje stan przez API, a strumień niesie tylko nowe zdarzenia.
      // LISTEN musi być aktywny, zanim ustalimy punkt startowy — inaczej NOTIFY z tej chwili by przepadły.
      await deps.events.ready();
      let lastId = resumeFrom;
      if (resumeFrom === 0) {
        const r = await deps.db.owner.query<{ max: number | null }>(
          'SELECT max(id) AS max FROM events',
        );
        lastId = r.rows[0]?.max ?? 0;
      }
      const token = req.cookies[SESSION_COOKIE] ?? '';

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-request-id': req.id,
      });
      let closed = false;
      const write = (e: NovaEvent) => {
        if (closed) return;
        res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        lastId = Math.max(lastId, e.id);
      };

      // Kolejkowanie pobrań, aby zachować kolejność zdarzeń.
      let chain = Promise.resolve();
      const pump = () => {
        chain = chain
          .then(async () => {
            if (closed) return;
            for (;;) {
              const items = await visibleEvents(auth.userId, lastId, 200);
              items.forEach(write);
              if (items.length < 200 || closed) break;
            }
          })
          .catch(() => undefined);
      };

      res.write(`retry: 3000\n: connected\n\n`);
      const unsubscribe = deps.events.subscribe((id) => {
        if (id > lastId) pump();
      });
      // Tekst odpowiedzi na żywo: tylko dla odbiorców rozmowy (jak `conversation.read`), bez id i bez zapisu.
      let viewer = auth;
      const unsubscribeLive = deps.live.subscribe((e) => {
        if (closed || !canSee(e.target, viewer)) return;
        res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.payload)}\n\n`);
      });
      pump();
      const keepalive = setInterval(() => !closed && res.write(': keepalive\n\n'), KEEPALIVE_MS);
      const recheck = setInterval(() => {
        void resolveSession(deps.db, deps.config, token).then((s) => {
          if (!s) close();
          else viewer = s;
        });
      }, SESSION_RECHECK_MS);

      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        unsubscribeLive();
        clearInterval(keepalive);
        clearInterval(recheck);
        res.end();
      };
      req.raw.on('close', close);
    });

    app.get('/notifications', async (req) => {
      const auth = requireAuth(req);
      const items = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, async (c) => {
        const r = await c.query<{
          id: string;
          kind: string;
          title: string;
          body: string;
          ref_type: string | null;
          ref_id: string | null;
          created_at: string;
          read_at: string | null;
        }>(
          `SELECT id, kind, title, body, ref_type, ref_id, created_at, read_at FROM notifications
            WHERE user_id = nova_uid() ORDER BY created_at DESC LIMIT 50`,
        );
        return r.rows.map((n): Notification => ({
          id: n.id,
          kind: n.kind,
          title: n.title,
          body: n.body,
          refType: n.ref_type,
          refId: n.ref_id,
          createdAt: n.created_at,
          readAt: n.read_at,
        }));
      });
      return { items, unread: items.filter((n) => !n.readAt).length };
    });

    app.post<{ Params: { id: string } }>('/notifications/:id/read', async (req) => {
      const auth = requireAuth(req);
      if (!isUuid(req.params.id)) throw notFound('Notification');
      const ok = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, async (c) => {
        const r = await c.query<{ household_id: string }>(
          `UPDATE notifications SET read_at = now() WHERE id = $1 AND read_at IS NULL
           RETURNING household_id`,
          [req.params.id],
        );
        const row = r.rows[0];
        // Liczniki nieprzeczytanych (menu, przegląd dnia, ikona aplikacji) odświeżają się od razu —
        // także na innych urządzeniach tej osoby.
        if (row)
          await emitEvent(c, {
            householdId: row.household_id,
            ownerUserId: auth.userId,
            visibility: 'private',
            type: 'notification.read',
            payload: { notificationId: req.params.id },
          });
        return !!row;
      });
      return { ok };
    });
  };
