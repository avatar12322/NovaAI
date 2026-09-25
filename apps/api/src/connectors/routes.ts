import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isUuid, requireAuth } from '../access';
import { writeAudit } from '../audit';
import { withUserTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { forbidden, HttpError, notFound } from '../lib/errors';
import { parse } from '../lib/validate';
import { ConnectorError, type Provider } from './types';

const ProviderParam = z.enum(['google', 'microsoft', 'slack']);
const StartBody = z.object({
  capabilities: z
    .array(z.enum(['calendar.freebusy', 'mail.search', 'mail.read', 'mail.send']))
    .min(1)
    .max(4),
});
const LocalEvent = z
  .object({
    title: z.string().trim().min(1).max(200),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
  })
  .refine((e) => Date.parse(e.endsAt) > Date.parse(e.startsAt), { message: 'koniec po początku' });

function connectorHttpError(err: unknown): never {
  if (err instanceof ConnectorError) {
    const status = err.code === 'not_configured' ? 503 : err.code === 'provider_error' ? 502 : 409;
    throw new HttpError(status, err.code, err.message);
  }
  throw err;
}

export const connectorRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const audit = (
      req: { id: string },
      userId: string | null,
      householdId: string | null,
      action: string,
      outcome: 'ok' | 'deny' | 'error',
      details: Record<string, unknown> = {},
    ) =>
      writeAudit(deps.db, {
        actorKind: userId ? 'user' : 'system',
        actorUserId: userId,
        ownerUserId: userId,
        householdId,
        source: 'connector',
        action,
        outcome,
        correlationId: req.id,
        details,
      });

    app.get('/connections', async (req) => {
      const auth = requireAuth(req);
      return { items: await deps.connections.list(auth.userId) };
    });

    app.post<{ Params: { provider: string } }>('/connections/:provider/start', async (req) => {
      const auth = requireAuth(req);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      const provider = parse(ProviderParam, req.params.provider) as Provider;
      const body = parse(StartBody, req.body);
      try {
        const url = await deps.connections.start(
          auth.userId,
          auth.householdId,
          provider,
          body.capabilities,
        );
        await audit(req, auth.userId, auth.householdId, 'connection.start', 'ok', {
          provider,
          capabilities: body.capabilities,
        });
        return { url };
      } catch (e) {
        connectorHttpError(e);
      }
    });

    /**
     * Powrót z OAuth. Ciasteczko sesji (SameSite=Strict) nie przychodzi przy nawigacji z domeny dostawcy —
     * użytkownika identyfikuje jednorazowy, krótko żyjący `state` związany z nim przy starcie.
     */
    app.get<{ Params: { provider: string }; Querystring: Record<string, string | undefined> }>(
      '/connections/:provider/callback',
      async (req, reply: FastifyReply) => {
        const back = (status: 'ok' | 'error', reason?: string) =>
          reply.redirect(
            `${deps.config.publicUrl}/#/settings?integration=${status}${reason ? `&reason=${encodeURIComponent(reason)}` : ''}`,
          );
        const provider = ProviderParam.safeParse(req.params.provider);
        const state = req.query.state ?? '';
        const code = req.query.code ?? '';
        if (
          !provider.success ||
          req.query.error ||
          !state ||
          !code ||
          state.length > 200 ||
          code.length > 2000
        ) {
          await audit(req, null, null, 'connection.callback', 'deny', {
            reason: req.query.error ?? 'invalid_request',
          });
          return back('error', req.query.error ? 'odmowa' : 'nieprawidlowe_zadanie');
        }
        try {
          const r = await deps.connections.callback(provider.data as Provider, state, code);
          await audit(req, r.userId, r.householdId, 'connection.connected', 'ok', {
            provider: provider.data,
          });
          return back('ok');
        } catch (e) {
          await audit(req, null, null, 'connection.callback', 'error', {
            reason: e instanceof ConnectorError ? e.code : 'error',
          });
          return back('error', e instanceof ConnectorError ? e.code : 'blad');
        }
      },
    );

    app.delete<{ Params: { provider: string } }>('/connections/:provider', async (req, reply) => {
      const auth = requireAuth(req);
      const provider = parse(ProviderParam, req.params.provider) as Provider;
      const ok = await deps.connections.disconnect(auth.userId, provider);
      if (!ok) throw notFound('Connection');
      await audit(req, auth.userId, auth.householdId, 'connection.disconnect', 'ok', { provider });
      return reply.status(204).send();
    });

    // ---------- Kalendarz: grant free/busy dla NovaAI i kalendarz lokalny ----------

    app.get('/calendar/freebusy-grant', async (req) => {
      const auth = requireAuth(req);
      const r = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, (c) =>
        c.query<{ id: string; created_at: string }>(
          `SELECT id, created_at FROM calendar_grants WHERE owner_user_id = nova_uid() AND revoked_at IS NULL`,
        ),
      );
      return { active: r.rows.length > 0, grant: r.rows[0] ?? null };
    });

    app.post('/calendar/freebusy-grant', async (req, reply) => {
      const auth = requireAuth(req);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      await deps.db.owner.query(
        `INSERT INTO calendar_grants (household_id, owner_user_id, capability, grantee) VALUES ($1, $2, 'calendar.freebusy', 'household_agent')
         ON CONFLICT DO NOTHING`,
        [auth.householdId, auth.userId],
      );
      await audit(req, auth.userId, auth.householdId, 'calendar.freebusy_grant', 'ok');
      return reply.status(201).send({ active: true });
    });

    app.delete('/calendar/freebusy-grant', async (req, reply) => {
      const auth = requireAuth(req);
      await deps.db.owner.query(
        `UPDATE calendar_grants SET revoked_at = now() WHERE owner_user_id = $1 AND revoked_at IS NULL`,
        [auth.userId],
      );
      await audit(req, auth.userId, auth.householdId, 'calendar.freebusy_revoke', 'ok');
      return reply.status(204).send();
    });

    app.get('/calendar/local-events', async (req) => {
      const auth = requireAuth(req);
      const r = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, (c) =>
        c.query<{ id: string; title: string; starts_at: string; ends_at: string }>(
          `SELECT id, title, starts_at, ends_at FROM local_calendar_events
            WHERE owner_user_id = nova_uid() AND ends_at > now() - interval '1 day' ORDER BY starts_at LIMIT 200`,
        ),
      );
      return {
        items: r.rows.map((e) => ({
          id: e.id,
          title: e.title,
          startsAt: e.starts_at,
          endsAt: e.ends_at,
        })),
      };
    });

    app.post('/calendar/local-events', async (req, reply) => {
      const auth = requireAuth(req);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      const body = parse(LocalEvent, req.body);
      const r = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, (c) =>
        c.query<{ id: string }>(
          `INSERT INTO local_calendar_events (household_id, owner_user_id, title, starts_at, ends_at)
           VALUES ($1, nova_uid(), $2, $3, $4) RETURNING id`,
          [auth.householdId, body.title, body.startsAt, body.endsAt],
        ),
      );
      return reply.status(201).send({ id: r.rows[0]!.id });
    });

    app.delete<{ Params: { id: string } }>('/calendar/local-events/:id', async (req, reply) => {
      const auth = requireAuth(req);
      if (!isUuid(req.params.id)) throw notFound('Event');
      const r = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, (c) =>
        c.query(`DELETE FROM local_calendar_events WHERE id = $1`, [req.params.id]),
      );
      if (r.rowCount !== 1) throw notFound('Event');
      return reply.status(204).send();
    });

    // ---------- Webhooki: weryfikacja nadawcy, okno czasowe, deduplikacja ----------

    await app.register(async (hooks) => {
      // Surowe ciało jest potrzebne do weryfikacji HMAC.
      hooks.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) =>
        done(null, body),
      );
      hooks.post('/webhooks/slack', async (req, reply) => {
        const secret = deps.config.slackSigningSecret;
        if (!secret)
          throw new HttpError(503, 'not_configured', 'Webhook Slack nie jest skonfigurowany');
        const raw = typeof req.body === 'string' ? req.body : '';
        const ts = String(req.headers['x-slack-request-timestamp'] ?? '');
        const sig = String(req.headers['x-slack-signature'] ?? '');
        const now = Math.floor(Date.now() / 1000);
        if (!/^\d+$/.test(ts) || Math.abs(now - Number(ts)) > 300) {
          await audit(req, null, null, 'webhook.slack', 'deny', { reason: 'stale_timestamp' });
          throw new HttpError(401, 'stale', 'Nieprawidłowy znacznik czasu');
        }
        const expected = `v0=${createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}`;
        const a = Buffer.from(expected);
        const b = Buffer.from(sig);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          await audit(req, null, null, 'webhook.slack', 'deny', { reason: 'bad_signature' });
          throw new HttpError(401, 'bad_signature', 'Nieprawidłowy podpis');
        }
        let payload: {
          type?: string;
          challenge?: string;
          event_id?: string;
          event?: { type?: string };
        };
        try {
          payload = JSON.parse(raw) as typeof payload;
        } catch {
          throw new HttpError(400, 'bad_json', 'Nieprawidłowy JSON');
        }
        if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
          return reply.send({ challenge: payload.challenge });
        }
        const deliveryId = payload.event_id ?? '';
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(deliveryId))
          throw new HttpError(400, 'no_event_id', 'Brak event_id');
        const ins = await deps.db.owner.query(
          `INSERT INTO webhook_deliveries (provider, delivery_id, event_type, status) VALUES ('slack', $1, $2, 'accepted')
           ON CONFLICT (provider, delivery_id) DO NOTHING`,
          [deliveryId, payload.event?.type?.slice(0, 60) ?? null],
        );
        // Przetwarzanie zdarzeń Slack (mapowanie na użytkownika, zadania) — nie zaimplementowano w tej wersji.
        return reply.send({ ok: true, duplicate: ins.rowCount === 0 });
      });
    });
  };
