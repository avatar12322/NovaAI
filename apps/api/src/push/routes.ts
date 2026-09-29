import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../access';
import { writeAudit } from '../audit';
import { withSystemTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { badRequest, forbidden, HttpError } from '../lib/errors';
import { RateLimiter } from '../lib/rate-limit';
import { parse } from '../lib/validate';

/**
 * Powiadomienia push na urządzeniach: włączenie (subskrypcja z przeglądarki), lista, wyłączenie, test.
 * Serwer wysyła żądania tylko do znanych usług push (bez dowolnych adresów — ochrona przed SSRF).
 */
const PUSH_HOSTS = [
  /(^|\.)push\.apple\.com$/, // Safari / iPhone (aplikacja na ekranie głównym)
  /^fcm\.googleapis\.com$/, // Chrome, Edge na Androidzie
  /(^|\.)push\.services\.mozilla\.com$/, // Firefox
  /(^|\.)notify\.windows\.com$/, // Edge na Windows
];
const MAX_DEVICES = 10;

const Subscribe = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({
    p256dh: z
      .string()
      .regex(/^[A-Za-z0-9_-]+=*$/)
      .max(200),
    auth: z
      .string()
      .regex(/^[A-Za-z0-9_-]+=*$/)
      .max(100),
  }),
  label: z.string().trim().max(120).optional(),
});
const Unsubscribe = z.object({ endpoint: z.string().max(1000) });

export function allowedEndpoint(endpoint: string, production: boolean): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(u.hostname))) return true;
  // Poza produkcją: lokalna atrapa usługi push (testy).
  return !production && u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname);
}

export const pushRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const testLimiter = new RateLimiter(5, 60_000);
    const member = (req: FastifyRequest) => {
      const auth = requireAuth(req);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      return { auth, householdId: auth.householdId };
    };
    const unavailable = () =>
      new HttpError(
        503,
        'push_unavailable',
        'Powiadomienia push wymagają klucza szyfrowania na serwerze (NOVA_SECRET_KEY)',
      );

    app.get('/push/config', async (req) => {
      member(req);
      if (!deps.push.available) return { available: false, publicKey: null };
      return { available: true, publicKey: await deps.push.publicKey() };
    });

    app.get('/push/subscriptions', async (req) => {
      const { auth } = member(req);
      const r = await deps.db.owner.query<{
        id: string;
        endpoint: string;
        label: string;
        created_at: string;
        last_ok_at: string | null;
      }>(
        `SELECT id, endpoint, label, created_at, last_ok_at FROM push_subscriptions
          WHERE user_id = $1 ORDER BY created_at`,
        [auth.userId],
      );
      return {
        items: r.rows.map((x) => ({
          id: x.id,
          endpoint: x.endpoint,
          label: x.label,
          createdAt: x.created_at,
          lastOkAt: x.last_ok_at,
        })),
      };
    });

    app.post('/push/subscriptions', async (req, reply) => {
      const { auth, householdId } = member(req);
      if (!deps.push.available) throw unavailable();
      const body = parse(Subscribe, req.body);
      if (!allowedEndpoint(body.endpoint, deps.config.env === 'production'))
        throw badRequest('Nieobsługiwana usługa powiadomień tej przeglądarki');
      await withSystemTx(deps.db, async (c) => {
        // Ten sam adres (to samo urządzenie) po zalogowaniu innej osoby przechodzi na nią.
        await c.query(
          `INSERT INTO push_subscriptions (household_id, user_id, endpoint, p256dh, auth, label)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (endpoint) DO UPDATE SET household_id = EXCLUDED.household_id,
             user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
             label = EXCLUDED.label, failures = 0`,
          [
            householdId,
            auth.userId,
            body.endpoint,
            body.keys.p256dh,
            body.keys.auth,
            body.label ?? '',
          ],
        );
        await c.query(
          `DELETE FROM push_subscriptions WHERE id IN (
             SELECT id FROM push_subscriptions WHERE user_id = $1
              ORDER BY created_at DESC OFFSET $2)`,
          [auth.userId, MAX_DEVICES],
        );
      });
      await writeAudit(deps.db, {
        actorKind: 'user',
        actorUserId: auth.userId,
        ownerUserId: auth.userId,
        householdId,
        source: 'api',
        action: 'push.subscribe',
        resourceType: 'push_subscription',
        resourceId: null,
        outcome: 'ok',
        correlationId: req.id,
        details: { host: new URL(body.endpoint).hostname },
      });
      return reply.status(201).send({ subscribed: true });
    });

    app.post('/push/unsubscribe', async (req) => {
      const { auth } = member(req);
      const { endpoint } = parse(Unsubscribe, req.body);
      const r = await deps.db.owner.query(
        'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
        [auth.userId, endpoint],
      );
      return { removed: r.rowCount ?? 0 };
    });

    // Próbne powiadomienie na wszystkie urządzenia pytającej osoby.
    app.post('/push/test', async (req) => {
      const { auth } = member(req);
      if (!deps.push.available) throw unavailable();
      if (!testLimiter.hit(auth.userId))
        throw new HttpError(429, 'rate_limited', 'Zbyt wiele prób — spróbuj za chwilę');
      const delivered = await deps.push.sendToUser(auth.userId, {
        title: 'NovaAI',
        body: 'Powiadomienia działają na tym urządzeniu.',
        url: '/#/settings',
        tag: 'test',
      });
      return { delivered };
    });
  };
