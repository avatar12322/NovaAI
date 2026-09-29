import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { DOCUMENT_LIMITS, LIMITS } from '@nova/contracts';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { resolveSession, SESSION_COOKIE, type AuthContext } from './auth/session';
import { passkeyRoutes } from './auth/passkeys';
import { authRoutes } from './auth/routes';
import type { AppDeps } from './deps';
import { HttpError } from './lib/errors';
import { RateLimiter, redactUrl } from './lib/rate-limit';
import { LOG_REDACT_PATHS } from './lib/redact';
import { approvalRoutes } from './modules/approvals';
import { budgetRoutes } from './modules/budget';
import { connectorRoutes } from './connectors/routes';
import { reminderRoutes } from './reminders/routes';
import { documentRoutes } from './documents/routes';
import { serviceRoutes } from './services/routes';
import { modelProviderRoutes } from './model/routes';
import { briefingRoutes } from './briefing/routes';
import { voiceRoutes } from './voice/routes';
import { calendarImportRoutes } from './calendar/routes';
import { householdRoutes } from './household/routes';
import { pushRoutes } from './push/routes';
import { digestRoutes } from './digest/routes';
import { shoppingRoutes } from './shopping/routes';
import { deviceRoutes } from './devices/routes';
import { conversationRoutes, enqueueAgentTurn } from './modules/conversations';
import { eventRoutes } from './modules/events';
import { healthRoutes } from './modules/health';
import { legalRoutes } from './modules/legal';
import { memoryRoutes } from './modules/memories';
import { taskRoutes } from './modules/tasks';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,80}$/;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** CSP frontendu: tylko własne skrypty i połączenia; style inline wyłącznie dla atrybutów `style`. */
const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  // Odczyt na głos (ElevenLabs): audio z odpowiedzi API odtwarzane jako blob.
  "media-src 'self' blob:",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

interface BuildOptions {
  logger?: boolean;
  /** Klucz publiczny do podpisu poleceń urządzeń (z createApp). Brak => moduł urządzeń wyłączony. */
  deviceServerPublicKey?: Buffer;
}

export async function buildServer(
  deps: AppDeps,
  opts: BuildOptions = {},
): Promise<FastifyInstance> {
  // Nagłówki z sekretami (cookie, authorization) są redagowane w logach.
  const logger: FastifyServerOptions['logger'] = opts.logger
    ? {
        level: 'info',
        redact: LOG_REDACT_PATHS,
        serializers: {
          // Bez parametrów z sekretami w URL (np. ?code=&state= z callbacku OAuth).
          req: (req) => ({ method: req.method, url: redactUrl(req.url), remoteAddress: req.ip }),
        },
      }
    : false;
  const app = Fastify({
    logger,
    bodyLimit: LIMITS.bodyBytes,
    // Za reverse proxy: liczba zaufanych przeskoków (req.ip = adres klienta, nie proxy).
    trustProxy: (_addr: string, hop: number) => hop < deps.config.trustProxy,
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
    if (req.url.startsWith('/api/')) {
      reply.header('cache-control', 'no-store');
    } else {
      // Frontend (NOVA_WEB_DIST): pliki z hashem w nazwie buforowane długo, reszta zawsze sprawdzana.
      reply.header(
        'cache-control',
        req.url.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
      reply.header('content-security-policy', WEB_CSP);
    }
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

  // Limity dla tras bez sesji (logowanie, enrolment, parowanie urządzeń).
  const unauthLimiter = new RateLimiter(30, 60_000);
  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0] ?? '';
    if (
      req.method === 'POST' &&
      (path.startsWith('/api/auth/passkeys/login/') ||
        path.startsWith('/api/auth/enroll/') ||
        path === '/api/device-link/pair')
    ) {
      if (!unauthLimiter.hit(`${req.ip}|${path}`))
        throw new HttpError(429, 'rate_limited', 'Zbyt wiele żądań — spróbuj za chwilę');
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, requestId: req.id, details: err.details },
      });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(413).send({
        error: {
          code: 'too_large',
          message: req.url.startsWith('/api/documents')
            ? `Plik przekracza limit ${Math.round(DOCUMENT_LIMITS.maxBytes / 1024 / 1024)} MB`
            : 'Żądanie jest za duże',
          requestId: req.id,
        },
      });
    }
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
      await api.register(passkeyRoutes(deps));
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
      await api.register(documentRoutes(deps));
      await api.register(serviceRoutes(deps));
      await api.register(modelProviderRoutes(deps));
      await api.register(briefingRoutes(deps));
      await api.register(voiceRoutes(deps));
      await api.register(calendarImportRoutes(deps));
      await api.register(householdRoutes(deps));
      await api.register(pushRoutes(deps));
      await api.register(digestRoutes(deps));
      await api.register(shoppingRoutes(deps));
    },
    { prefix: '/api' },
  );

  // Publiczne strony prawne (bez logowania): /privacy, /terms.
  await app.register(legalRoutes(deps));

  // Produkcja: frontend z tego samego originu co API (ciasteczka SameSite=Strict, origin WebAuthn).
  if (deps.config.webDist) {
    await app.register(fastifyStatic, {
      root: deps.config.webDist,
      prefix: '/',
      index: ['index.html'],
      cacheControl: false,
      dotfiles: 'deny',
    });
  }

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
