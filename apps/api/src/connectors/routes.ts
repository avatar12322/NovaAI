import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isUuid, requireAuth } from '../access';
import { writeAudit } from '../audit';
import { withSystemTx, withUserTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { forbidden, HttpError, notFound } from '../lib/errors';
import { parse } from '../lib/validate';
import { emitEvent } from '../events';
import { slackLive } from './slack-tools';
import { ConnectorError, type Provider } from './types';

const ProviderParam = z.enum(['google', 'microsoft', 'slack']);
const StartBody = z.object({
  capabilities: z
    .array(
      z.enum([
        'calendar.freebusy',
        'calendar.read',
        'mail.search',
        'mail.read',
        'mail.send',
        'mail.draft',
        'chat.read',
        'chat.read_private',
        'chat.read_dm',
        'chat.send',
      ]),
    )
    .min(1)
    .max(10),
});

/** Odczyt Slacka na żywo (wyniki nie są zapisywane — zasady Real-time Search API). */
const SlackLiveBody = z.object({
  kind: z.enum(['mentions', 'search']),
  query: z.string().trim().min(1).max(200).optional(),
  days: z.number().int().min(1).max(30).default(7),
  max: z.number().int().min(1).max(20).default(10),
});

/**
 * Powód odmowy z przekierowania dostawcy. Microsoft zgłasza wymóg zgody administratora organizacji kodami
 * AADSTS w `error_description` (np. 90094 — uprawnienie wymaga administratora, 65001 — brak zgody) albo
 * błędem `consent_required`. Opis nie jest zapisywany — tylko wyprowadzony krótki powód.
 */
export function callbackErrorReason(error: string, description: string | undefined): string {
  const d = description ?? '';
  if (
    error === 'consent_required' ||
    /AADSTS(90094|900941|90099|65001)\b/.test(d) ||
    /admin(istrator)?\s+(approval|consent|permission)/i.test(d)
  )
    return 'zgoda_administratora';
  return 'odmowa';
}
const LocalEvent = z
  .object({
    title: z.string().trim().min(1).max(200),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
  })
  .refine((e) => Date.parse(e.endsAt) > Date.parse(e.startsAt), { message: 'koniec po początku' });

function connectorHttpError(err: unknown): never {
  if (err instanceof ConnectorError) {
    // Przejściowe (limit zapytań, brak sieci) — 503 „spróbuj później”; błąd dostawcy — 502; stan konta — 409.
    const status =
      err.code === 'not_configured' || err.retryable
        ? 503
        : err.code === 'provider_error'
          ? 502
          : 409;
    throw new HttpError(status, err.reason ?? err.code, err.message);
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
        const provider = ProviderParam.safeParse(req.params.provider);
        const back = (status: 'ok' | 'error', reason?: string) =>
          reply.redirect(
            `${deps.config.publicUrl}/#/settings?integration=${status}` +
              (provider.success ? `&provider=${provider.data}` : '') +
              (reason ? `&reason=${encodeURIComponent(reason)}` : ''),
          );
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
          const reason = req.query.error
            ? callbackErrorReason(req.query.error, req.query.error_description)
            : 'nieprawidlowe_zadanie';
          await audit(req, null, null, 'connection.callback', 'deny', {
            provider: provider.success ? provider.data : null,
            error: (req.query.error ?? 'invalid_request').slice(0, 60),
            reason,
          });
          return back('error', reason);
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
      const r = await deps.connections.disconnect(auth.userId, provider);
      if (!r) throw notFound('Connection');
      await audit(req, auth.userId, auth.householdId, 'connection.disconnect', 'ok', {
        provider,
        providerRevoked: r.providerRevoked,
      });
      return reply.send({ disconnected: true, providerRevoked: r.providerRevoked });
    });

    /**
     * Wiadomości ze Slacka na żywo, tokenem WYŁĄCZNIE pytającej osoby. Odpowiedź nie jest zapisywana ani
     * buforowana; w audycie tylko rodzaj i liczba wyników.
     */
    app.post('/connections/slack/live', async (req, reply) => {
      const auth = requireAuth(req);
      const body = parse(SlackLiveBody, req.body);
      if (body.kind === 'search' && !body.query)
        throw new HttpError(400, 'invalid_request', 'Brak zapytania');
      try {
        const items = await slackLive(deps.connections, auth.userId, body);
        await audit(req, auth.userId, auth.householdId, 'connection.live_read', 'ok', {
          provider: 'slack',
          kind: body.kind,
          count: items.length,
        });
        reply.header('cache-control', 'no-store');
        return { items };
      } catch (e) {
        connectorHttpError(e);
      }
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
            WHERE owner_user_id = nova_uid() AND import_id IS NULL AND ends_at > now() - interval '1 day'
            ORDER BY starts_at LIMIT 200`,
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
          team_id?: unknown;
          event?: { type?: string; tokens?: { oauth?: unknown[] } };
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
        const retryNum = Number(req.headers['x-slack-retry-num'] ?? 0) || 0;
        const retryReason = String(req.headers['x-slack-retry-reason'] ?? '').slice(0, 40);
        // Deduplikacja i przetworzenie w jednej transakcji: ponowienie (ten sam event_id) po udanym przetworzeniu
        // jest tylko liczone; błąd przetwarzania => wycofanie i 500, więc Slack ponowi dostawę.
        const outcome = await withSystemTx(deps.db, async (tx) => {
          const eventType = payload.event?.type?.slice(0, 60) ?? null;
          const handled = eventType === 'tokens_revoked' || eventType === 'app_uninstalled';
          const ins = await tx.query(
            `INSERT INTO webhook_deliveries (provider, delivery_id, event_type, status) VALUES ('slack', $1, $2, $3)
             ON CONFLICT (provider, delivery_id) DO NOTHING`,
            [deliveryId, eventType, handled ? 'accepted' : 'ignored'],
          );
          if (ins.rowCount === 0) {
            await tx.query(
              `UPDATE webhook_deliveries SET duplicates = duplicates + 1 WHERE provider = 'slack' AND delivery_id = $1`,
              [deliveryId],
            );
            return {
              duplicate: true,
              affected: [] as Array<{ ownerUserId: string; householdId: string }>,
            };
          }
          const teamId = typeof payload.team_id === 'string' ? payload.team_id : '';
          if (!handled || !/^[A-Z0-9]{1,32}$/.test(teamId))
            return { duplicate: false, affected: [] };
          const users =
            eventType === 'tokens_revoked'
              ? (payload.event?.tokens?.oauth ?? []).filter(
                  (u): u is string => typeof u === 'string' && /^[A-Z0-9]{1,32}$/.test(u),
                )
              : null;
          if (users && users.length === 0) return { duplicate: false, affected: [] };
          const affected = await deps.connections.revokedByProvider(tx, 'slack', teamId, users);
          for (const a of affected) {
            const n = await tx.query<{ id: string }>(
              `INSERT INTO notifications (household_id, user_id, kind, title, body, ref_type, ref_id, idempotency_key)
               VALUES ($1, $2, 'connection', 'Slack: dostęp cofnięty', $3, 'connection', 'slack', $4)
               ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
              [
                a.householdId,
                a.ownerUserId,
                eventType === 'app_uninstalled'
                  ? 'Aplikację NovaAI usunięto z workspace’u Slack. Połącz konto ponownie w Ustawieniach, jeśli chcesz dalej korzystać ze Slacka.'
                  : 'Token NovaAI został odwołany w Slacku. Połącz konto ponownie w Ustawieniach, jeśli chcesz dalej korzystać ze Slacka.',
                `slack:${deliveryId}:${a.ownerUserId}`,
              ],
            );
            if (n.rows[0])
              await emitEvent(tx, {
                householdId: a.householdId,
                ownerUserId: a.ownerUserId,
                visibility: 'private',
                type: 'notification.created',
                payload: { notificationId: n.rows[0].id, kind: 'connection' },
              });
          }
          return { duplicate: false, affected };
        });
        await audit(req, null, null, 'webhook.slack', 'ok', {
          eventType: payload.event?.type?.slice(0, 60) ?? null,
          duplicate: outcome.duplicate,
          retryNum,
          retryReason: retryReason || null,
          affected: outcome.affected.length,
        });
        return reply.send({ ok: true, duplicate: outcome.duplicate });
      });
    });
  };
