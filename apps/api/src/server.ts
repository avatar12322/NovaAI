import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import { LIMITS } from '@nova/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { resolveSession, SESSION_COOKIE, type AuthContext } from './auth/session';
import { authRoutes } from './auth/routes';
import type { AppDeps } from './deps';
import { HttpError } from './lib/errors';
import { LOG_REDACT_PATHS } from './lib/redact';
import { approvalRoutes } from './modules/approvals';
import { budgetRoutes } from './modules/budget';
import { connectorRoutes } from './connectors/routes';
import { reminderRoutes } from './reminders/routes';
import { deviceRoutes } from './devices/routes';
import { conversationRoutes, enqueueAgentTurn } from './modules/conversations';
import { eventRoutes } from './modules/events';
import { healthRoutes } from './modules/health';
import { memoryRoutes } from './modules/memories';
import { taskRoutes } from './modules/tasks';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,80}$/;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface BuildOptions {
  logger?: boolean;
  /** Klucz publiczny do podpisu poleceń urządzeń (z createApp). Brak => moduł urządzeń wyłączony. */
  deviceServerPublicKey?: Buffer;
}

export async function buildServer(
  deps: AppDeps,
  opts: BuildOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    // Nagłówki z sekretami (cookie, authorization) są redagowane w logach.
    logger: opts.logger ? { level: 'info', redact: LOG_REDACT_PATHS } : false,
    bodyLimit: LIMITS.bodyBytes,
    trustProxy: false,
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && REQUEST_ID_RE.test(h) ? h : randomUUID();
    },
  });

  await app.register(cookie);
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
    // Ochrona CSRF: mutacje wymagają niestandardowego nagłówka (wymusza preflight CORS,
    // którego serwer nie obsługuje dla obcych originów) + ciasteczko SameSite=Strict.
    if (
      MUTATING.has(req.method) &&
      req.url.startsWith('/api/') &&
      !req.url.startsWith('/api/device-link/') &&
      !req.url.startsWith('/api/webhooks/')
    ) {
      if (req.headers['x-nova-csrf'] !== '1') {
        throw new HttpError(403, 'csrf', 'Brak nagłówka x-nova-csrf');
      }
      const origin = req.headers.origin;
      if (origin && origin !== deps.config.webOrigin && !isLocalOrigin(origin, deps.config.env)) {
        throw new HttpError(403, 'origin', 'Niedozwolony origin');
      }
    }
    const token = req.cookies[SESSION_COOKIE];
    if (token) req.auth = await resolveSession(deps.db, deps.config, token);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, requestId: req.id, details: err.details },
      });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send({
        error: {
          code: e.code ?? 'bad_request',
          message: e.message ?? 'Błędne żądanie',
          requestId: req.id,
        },
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply
      .status(500)
      .send({ error: { code: 'internal', message: 'Błąd serwera', requestId: req.id } });
  });

  app.setNotFoundHandler((req, reply) =>
    reply
      .status(404)
      .send({ error: { code: 'not_found', message: 'Nie znaleziono', requestId: req.id } }),
  );

  await app.register(
    async (api) => {
      await api.register(healthRoutes(deps));
      await api.register(authRoutes(deps));
      await api.register(conversationRoutes(deps, enqueueAgentTurn));
      await api.register(memoryRoutes(deps));
      await api.register(taskRoutes(deps));
      await api.register(approvalRoutes(deps));
      await api.register(eventRoutes(deps));
      await api.register(budgetRoutes(deps));
      if (opts.deviceServerPublicKey)
        await api.register(deviceRoutes(deps, opts.deviceServerPublicKey));
      await api.register(connectorRoutes(deps));
      await api.register(reminderRoutes(deps));
    },
    { prefix: '/api' },
  );

  app.addHook('onClose', async () => deps.devices.hub.closeAll());
  return app;
}

function isLocalOrigin(origin: string, env: string): boolean {
  if (env === 'production') return false;
  try {
    const u = new URL(origin);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}
