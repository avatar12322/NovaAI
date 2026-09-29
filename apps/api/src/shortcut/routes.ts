import { LIMITS } from '@nova/contracts';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../access';
import { writeAudit } from '../audit';
import { withUserTx, type Db } from '../db/pool';
import type { AppDeps } from '../deps';
import { randomToken, sha256 } from '../lib/crypto';
import { forbidden } from '../lib/errors';
import { RateLimiter } from '../lib/rate-limit';
import {
  createConversation,
  enqueueAgentTurn,
  fetchConversation,
  insertMessage,
} from '../modules/conversations';

/**
 * Skrót Siri „Zapytaj Novę”: aplikacja Skróty wysyła pytanie z osobistym kluczem (Authorization: Bearer),
 * serwer zadaje je prywatnemu asystentowi w rozmowie „Siri” i zwraca odpowiedź zwykłym tekstem —
 * Siri czyta ją na głos. Klucz działa tylko tutaj (bez ciasteczek — trasa bez nagłówka CSRF).
 */
export const SHORTCUT_ASK_PATH = '/api/shortcut/ask';
const KEY_PREFIX = 'nova_siri_';
/** Skróty czekają na odpowiedź ok. minuty; Siri krócej — po tym czasie odpowiedź zostaje w aplikacji. */
const REPLY_WAIT_MS = 25_000;
const Ask = z.object({ question: z.string().trim().min(1).max(LIMITS.messageChars) });

export type ReplyOutcome =
  { status: 'done' | 'approval'; text: string } | { status: 'failed' | 'timeout' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Czeka, aż tura asystenta skończy się albo stanie na zgodzie; zwraca ostatnią odpowiedź tej tury
 * (po narzędziach — odpowiedź uzupełniającą).
 */
// ponytail: odpytywanie bazy co 250 ms; przy wielu jednoczesnych pytaniach — nasłuch zdarzeń (LISTEN).
export async function waitForReply(
  db: Db,
  taskId: string,
  timeoutMs: number,
): Promise<ReplyOutcome> {
  const deadline = Date.now() + timeoutMs;
  let status: string | undefined;
  for (;;) {
    const t = await db.owner.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [
      taskId,
    ]);
    status = t.rows[0]?.status;
    if (status !== 'queued' && status !== 'running') break;
    if (Date.now() >= deadline) return { status: 'timeout' };
    await sleep(250);
  }
  if (status !== 'completed' && status !== 'waiting_approval') return { status: 'failed' };
  const m = await db.owner.query<{ content: string }>(
    `SELECT content FROM messages WHERE role = 'assistant' AND meta->>'taskId' = $1
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [taskId],
  );
  if (!m.rows[0]) return { status: 'failed' };
  return { status: status === 'completed' ? 'done' : 'approval', text: m.rows[0].content };
}

/** Tekst do przeczytania na głos: bez odnośników do źródeł i znaczników formatowania. */
export function forSpeech(text: string): string {
  return text
    .replace(/\s*\[D\d+\]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*#+\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .trim();
}

export function speechFor(outcome: ReplyOutcome): string {
  switch (outcome.status) {
    case 'done':
      return forSpeech(outcome.text);
    case 'approval':
      return `${forSpeech(outcome.text)}\nZgoda czeka w aplikacji NovaAI.`;
    case 'timeout':
      return 'Jeszcze nad tym pracuję. Odpowiedź znajdziesz w aplikacji NovaAI, w rozmowie Siri.';
    case 'failed':
      return 'Nie udało mi się teraz odpowiedzieć. Spróbuj ponownie za chwilę.';
  }
}

interface KeyOwner {
  user_id: string;
  household_id: string;
  conversation_id: string | null;
}

async function keyOwner(deps: AppDeps, key: string): Promise<KeyOwner | null> {
  if (!key.startsWith(KEY_PREFIX) || key.length > 100) return null;
  // Jak przy sesjach: konto wyłączone, członkostwo nieaktywne albo konto testowe w produkcji — klucz nieważny.
  const r = await deps.db.owner.query<KeyOwner>(
    `SELECT k.user_id, k.household_id, k.conversation_id
       FROM shortcut_keys k
       JOIN users u ON u.id = k.user_id
       JOIN memberships m ON m.user_id = k.user_id AND m.household_id = k.household_id
      WHERE k.key_hash = $1 AND u.disabled_at IS NULL AND m.status = 'active'
        AND NOT (u.is_dev_fixture AND $2)`,
    [sha256(key), deps.config.env === 'production'],
  );
  return r.rows[0] ?? null;
}

const text = (reply: FastifyReply, status: number, body: string) =>
  reply.status(status).type('text/plain; charset=utf-8').send(body);

export const shortcutRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const askLimiter = new RateLimiter(10, 60_000);
    const ipLimiter = new RateLimiter(30, 60_000);
    const member = (req: FastifyRequest) => {
      const auth = requireAuth(req);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      return { ...auth, householdId: auth.householdId };
    };
    const askUrl = `${deps.config.publicUrl}${SHORTCUT_ASK_PATH}`;

    app.get('/shortcut', async (req) => {
      const auth = member(req);
      const r = await deps.db.owner.query<{ created_at: string; last_used_at: string | null }>(
        'SELECT created_at, last_used_at FROM shortcut_keys WHERE user_id = $1',
        [auth.userId],
      );
      const k = r.rows[0];
      return {
        enabled: Boolean(k),
        createdAt: k?.created_at ?? null,
        lastUsedAt: k?.last_used_at ?? null,
        url: askUrl,
      };
    });

    // Nowy klucz zastępuje poprzedni (stary przestaje działać); rozmowa „Siri” zostaje ta sama.
    app.post('/shortcut/key', async (req, reply) => {
      const auth = member(req);
      const key = `${KEY_PREFIX}${randomToken(32)}`;
      await deps.db.owner.query(
        `INSERT INTO shortcut_keys (user_id, household_id, key_hash) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE
           SET household_id = EXCLUDED.household_id, key_hash = EXCLUDED.key_hash,
               created_at = now(), last_used_at = NULL`,
        [auth.userId, auth.householdId, sha256(key)],
      );
      await writeAudit(deps.db, {
        actorKind: 'user',
        actorUserId: auth.userId,
        ownerUserId: auth.userId,
        householdId: auth.householdId,
        source: 'api',
        action: 'shortcut.key_created',
        outcome: 'ok',
        correlationId: req.id,
      });
      return reply.status(201).send({ key, url: askUrl });
    });

    app.delete('/shortcut/key', async (req, reply) => {
      const auth = member(req);
      await deps.db.owner.query('DELETE FROM shortcut_keys WHERE user_id = $1', [auth.userId]);
      await writeAudit(deps.db, {
        actorKind: 'user',
        actorUserId: auth.userId,
        ownerUserId: auth.userId,
        householdId: auth.householdId,
        source: 'api',
        action: 'shortcut.key_revoked',
        outcome: 'ok',
        correlationId: req.id,
      });
      return reply.status(204).send();
    });

    // Odpowiedzi (także błędy) zwykłym tekstem — Skróty pokazują je, a Siri czyta na głos.
    app.post('/shortcut/ask', async (req, reply) => {
      // Jak inne trasy bez sesji: limit na adres przed sprawdzeniem klucza (klucz ma 256 bitów).
      if (!ipLimiter.hit(req.ip)) return text(reply, 429, 'Zbyt wiele prób. Spróbuj za chwilę.');
      const header = req.headers.authorization ?? '';
      const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      const owner = key ? await keyOwner(deps, key) : null;
      if (!owner) {
        return text(
          reply,
          401,
          'Klucz skrótu jest nieprawidłowy albo wyłączony. Utwórz nowy w NovaAI: Ustawienia, Skrót Siri.',
        );
      }
      if (!askLimiter.hit(owner.user_id))
        return text(reply, 429, 'Za dużo pytań naraz. Spróbuj za minutę.');
      const body = Ask.safeParse(req.body);
      if (!body.success) return text(reply, 400, 'Nie usłyszałam pytania. Spróbuj jeszcze raz.');

      const { conversation, message } = await withUserTx(
        deps.db,
        { userId: owner.user_id, scope: 'user' },
        async (c) => {
          let conv = null;
          if (owner.conversation_id) {
            const open = await c.query(
              'SELECT 1 FROM conversations WHERE id = $1 AND archived_at IS NULL',
              [owner.conversation_id],
            );
            if (open.rowCount) conv = await fetchConversation(c, owner.conversation_id);
          }
          conv ??= await createConversation(c, owner.household_id, 'private', 'Siri');
          const msg = await insertMessage(c, {
            conversationId: conv.id,
            role: 'user',
            authorUserId: owner.user_id,
            content: body.data.question,
            meta: { via: 'siri' },
            requestId: req.id,
          });
          return { conversation: conv, message: msg };
        },
      );
      await deps.db.owner.query(
        'UPDATE shortcut_keys SET conversation_id = $2, last_used_at = now() WHERE user_id = $1',
        [owner.user_id, conversation.id],
      );
      await writeAudit(deps.db, {
        actorKind: 'user',
        actorUserId: owner.user_id,
        ownerUserId: owner.user_id,
        householdId: owner.household_id,
        source: 'api',
        action: 'shortcut.ask',
        resourceType: 'conversation',
        resourceId: conversation.id,
        outcome: 'ok',
        correlationId: req.id,
      });
      const { taskId } = await enqueueAgentTurn({
        deps,
        auth: { userId: owner.user_id, householdId: owner.household_id },
        conversation,
        message,
        requestId: req.id,
      });
      const outcome: ReplyOutcome = taskId
        ? await waitForReply(deps.db, taskId, REPLY_WAIT_MS)
        : { status: 'failed' };
      return text(reply, 200, speechFor(outcome));
    });
  };
