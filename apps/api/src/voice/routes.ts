import { createHash } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../access';
import { writeAudit } from '../audit';
import { buildBriefing } from '../briefing/routes';
import { withUserTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { badRequest, forbidden, HttpError, notFound } from '../lib/errors';
import { RateLimiter } from '../lib/rate-limit';
import { parse } from '../lib/validate';
import { TtsError } from './elevenlabs';

/**
 * Odczyt na głos głosem ElevenLabs. Serwer czyta wyłącznie to, co użytkownik i tak widzi: odpowiedź asystenta
 * z dostępnej rozmowy (po id, przez RLS) albo własny przegląd dnia — to nie jest ogólny zamiennik tekstu na mowę.
 * Koszt: miesięczny limit znaków na dom, pamięć podręczna (ponowny odczyt bez kosztu) i limit zapytań na osobę.
 */
const MAX_CHARS = 2500;
const CACHE_MAX = 30;

/** Tekst do odczytu: bez odnośników [D1] i znaczników Markdown; długie odpowiedzi skracane na końcu zdania. */
export function speakableText(text: string): string {
  const clean = text
    .replace(/\[D\d+\]/g, '')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= MAX_CHARS) return clean;
  const cut = clean.slice(0, MAX_CHARS);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return `${end > MAX_CHARS / 2 ? cut.slice(0, end + 1) : cut} Dalsza część jest w czacie.`;
}

const TtsBody = z.union([
  z.object({ messageId: z.uuid() }),
  z.object({ briefing: z.literal(true) }),
]);

export const ttsRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const limiter = new RateLimiter(30, 60_000);
    const cache = new Map<string, Buffer>();

    const household = (req: FastifyRequest) => {
      const auth = requireAuth(req);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      return { auth, householdId: auth.householdId };
    };
    const monthChars = async (householdId: string) =>
      (
        await deps.db.owner.query<{ n: number }>(
          `SELECT coalesce(sum(chars), 0)::int AS n FROM tts_usage
            WHERE household_id = $1
              AND created_at >= date_trunc('month', now() AT TIME ZONE 'Europe/Warsaw') AT TIME ZONE 'Europe/Warsaw'`,
          [householdId],
        )
      ).rows[0]!.n;

    app.get('/tts/status', async (req) => {
      const { householdId } = household(req);
      const tts = deps.tts;
      return {
        provider: tts ? 'elevenlabs' : null,
        voiceId: tts?.voiceId ?? null,
        modelId: tts?.modelId ?? null,
        monthChars: tts ? await monthChars(householdId) : 0,
        monthlyLimit: deps.config.tts.monthlyChars || null,
      };
    });

    app.post('/tts', async (req, reply) => {
      const { auth, householdId } = household(req);
      const tts = deps.tts;
      if (!tts)
        throw new HttpError(
          503,
          'tts_not_configured',
          'Głos ElevenLabs nie jest skonfigurowany (ELEVENLABS_API_KEY)',
        );
      const body = parse(TtsBody, req.body);
      let source: 'message' | 'briefing';
      let raw: string;
      if ('messageId' in body) {
        const r = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, (c) =>
          c.query<{ content: string; role: string }>(
            'SELECT content, role FROM messages WHERE id = $1',
            [body.messageId],
          ),
        );
        const m = r.rows[0];
        if (!m || m.role !== 'assistant') throw notFound('Wiadomość');
        raw = m.content;
        source = 'message';
      } else {
        raw = (await buildBriefing(deps, auth)).summary;
        source = 'briefing';
      }
      const text = speakableText(raw);
      if (!text) throw badRequest('Brak tekstu do odczytu');

      const key = createHash('sha256')
        .update(`${tts.voiceId}|${tts.modelId}|${text}`)
        .digest('hex');
      let audio = cache.get(key);
      if (audio) {
        cache.delete(key); // najdawniej używane wypadają pierwsze
        cache.set(key, audio);
      } else {
        if (!limiter.hit(auth.userId))
          throw new HttpError(429, 'rate_limited', 'Zbyt wiele odczytów — spróbuj za chwilę');
        const limit = deps.config.tts.monthlyChars;
        if (limit > 0 && (await monthChars(householdId)) + text.length > limit)
          throw new HttpError(
            429,
            'tts_limit',
            `Wyczerpany miesięczny limit znaków głosu (${limit}) — czytam głosem przeglądarki`,
          );
        const audit = (outcome: 'ok' | 'error', details: Record<string, unknown>) =>
          writeAudit(deps.db, {
            actorKind: 'user',
            actorUserId: auth.userId,
            ownerUserId: auth.userId,
            householdId,
            source: 'api',
            action: 'tts.synthesize',
            resourceType: source,
            resourceId: 'messageId' in body ? body.messageId : null,
            outcome,
            correlationId: req.id,
            details: { provider: 'elevenlabs', chars: text.length, ...details },
          });
        try {
          audio = await tts.synthesize(text);
        } catch (e) {
          if (!(e instanceof TtsError)) throw e;
          await audit('error', { reason: e.code });
          throw new HttpError(502, `tts_${e.code}`, e.message);
        }
        await deps.db.owner.query(
          'INSERT INTO tts_usage (household_id, user_id, chars) VALUES ($1, $2, $3)',
          [householdId, auth.userId, text.length],
        );
        await audit('ok', {});
        cache.set(key, audio);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
      }
      return reply.header('content-type', 'audio/mpeg').send(audio);
    });
  };
