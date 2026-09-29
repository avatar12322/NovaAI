import type { FastifyPluginAsync } from 'fastify';
import { isUuid, requireAuth } from '../access';
import { withUserTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { badRequest, forbidden, HttpError, notFound } from '../lib/errors';
import { RateLimiter } from '../lib/rate-limit';

/**
 * Zdjęcia w rozmowach: wgranie (surowe bajty, JPEG/PNG/WebP — aplikacja zmniejsza zdjęcie przed wysłaniem)
 * i podgląd. Zdjęcie jest prywatne autora do czasu dołączenia do wiadomości; potem ma widoczność rozmowy (RLS).
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
type ImageType = (typeof TYPES)[number];

/** Rozpoznanie formatu po nagłówku pliku (nie ufamy samemu Content-Type). */
export function sniffImage(b: Buffer): ImageType | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (
    b.length > 12 &&
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

export const imageRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const limiter = new RateLimiter(30, 60_000);
    for (const type of TYPES)
      app.addContentTypeParser(
        type,
        { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES },
        (_r, body, done) => done(null, body),
      );

    app.post('/chat-images', { bodyLimit: MAX_IMAGE_BYTES }, async (req, reply) => {
      const auth = requireAuth(req);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      if (!limiter.hit(auth.userId))
        throw new HttpError(429, 'rate_limited', 'Zbyt wiele zdjęć — spróbuj za chwilę');
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length < 100) throw badRequest('Wybierz zdjęcie');
      const mime = sniffImage(body);
      if (!mime) throw badRequest('Obsługiwane zdjęcia: JPEG, PNG, WebP');
      const hh = auth.householdId;
      const id = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, async (c) => {
        const r = await c.query<{ id: string }>(
          `INSERT INTO chat_images (household_id, owner_user_id, mime, bytes)
           VALUES ($1, nova_uid(), $2, $3) RETURNING id`,
          [hh, mime, body],
        );
        return r.rows[0]!.id;
      });
      return reply.status(201).send({ id });
    });

    app.get<{ Params: { id: string } }>('/chat-images/:id', async (req, reply) => {
      const auth = requireAuth(req);
      if (!isUuid(req.params.id)) throw notFound('Zdjęcie');
      const img = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, async (c) => {
        const r = await c.query<{ mime: string; bytes: Buffer }>(
          'SELECT mime, bytes FROM chat_images WHERE id = $1',
          [req.params.id],
        );
        return r.rows[0];
      });
      if (!img) throw notFound('Zdjęcie');
      return reply
        .header('content-type', img.mime)
        .header('cache-control', 'private, max-age=86400, immutable')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .send(img.bytes);
    });
  };
