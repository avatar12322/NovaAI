import {
  CreateConversationRequest,
  ListConversationsQuery,
  PageQuery,
  PostMessageRequest,
  type Conversation,
  type Message,
} from '@nova/contracts';
import { decideCreate } from '@nova/permissions';
import type { FastifyPluginAsync } from 'fastify';
import type { AuthContext } from '../auth/session';
import type pg from 'pg';
import { actorFor, authorize, requireAuth } from '../access';
import { writeAudit } from '../audit';
import { withUserTx } from '../db/pool';
import { emitEvent } from '../events';
import { createTask } from '../queue/tasks';
import type { AppDeps } from '../deps';
import { decodeCursor, pageResult } from '../lib/cursor';
import { forbidden, notFound } from '../lib/errors';
import { parse } from '../lib/validate';

interface ConversationRow {
  id: string;
  visibility: 'private' | 'shared';
  title: string;
  owner_user_id: string;
  agent_id: string;
  agent_kind: 'private' | 'household';
  agent_name: string;
  created_at: string;
  updated_at: string;
}

const CONV_SELECT = `
  SELECT c.id, c.visibility, c.title, c.owner_user_id, c.agent_id, a.kind AS agent_kind, a.name AS agent_name,
         c.created_at, c.updated_at
    FROM conversations c JOIN agents a ON a.id = c.agent_id`;

export const toConversation = (r: ConversationRow): Conversation => ({
  id: r.id,
  space: r.visibility,
  visibility: r.visibility,
  title: r.title,
  ownerUserId: r.owner_user_id,
  agent: { id: r.agent_id, kind: r.agent_kind, name: r.agent_name },
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

interface MessageRow {
  id: string;
  conversation_id: string;
  role: Message['role'];
  author_user_id: string | null;
  author_name: string | null;
  content: string;
  meta: Record<string, unknown>;
  created_at: string;
}

export const MESSAGE_SELECT = `
  SELECT m.id, m.conversation_id, m.role, m.author_user_id, u.display_name AS author_name, m.content, m.meta,
         m.created_at
    FROM messages m LEFT JOIN users u ON u.id = m.author_user_id`;

export const toMessage = (r: MessageRow): Message => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  authorUserId: r.author_user_id,
  authorName: r.author_name,
  content: r.content,
  meta: r.meta ?? {},
  createdAt: r.created_at,
});

export async function fetchConversation(
  c: pg.PoolClient,
  id: string,
): Promise<Conversation | null> {
  const { rows } = await c.query<ConversationRow>(`${CONV_SELECT} WHERE c.id = $1`, [id]);
  return rows[0] ? toConversation(rows[0]) : null;
}

export async function insertMessage(
  c: pg.PoolClient,
  m: {
    conversationId: string;
    role: Message['role'];
    authorUserId: string | null;
    content: string;
    meta?: Record<string, unknown>;
    requestId?: string | null;
  },
): Promise<Message> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO messages (conversation_id, role, author_user_id, content, meta, request_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      m.conversationId,
      m.role,
      m.authorUserId,
      m.content,
      JSON.stringify(m.meta ?? {}),
      m.requestId ?? null,
    ],
  );
  await c.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [m.conversationId]);
  const full = await c.query<MessageRow>(`${MESSAGE_SELECT} WHERE m.id = $1`, [rows[0]!.id]);
  return toMessage(full.rows[0]!);
}

const DEFAULT_TITLES = new Set(['Nowa rozmowa', 'Wspólna rozmowa']);

/** Pierwsza linia tekstu, bez nadmiarowych spacji, przycięta do `max` znaków. */
export function shortText(text: string, max: number): string {
  const line = text.trim().split('\n')[0]!.replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  // Cięcie na granicy słowa, jeśli nie skraca tekstu o więcej niż połowę.
  const space = line.lastIndexOf(' ', max - 1);
  const end = space > max / 2 ? space : max - 1;
  return `${line.slice(0, end).replace(/[\s,.;:–-]+$/, '')}…`;
}

export type MessageHandler = (args: {
  deps: AppDeps;
  auth: AuthContext;
  conversation: Conversation;
  message: Message;
  requestId: string;
}) => Promise<{ taskId: string | null }>;

/** Tura agenta jako trwałe zadanie w kolejce (odporność na restart, postęp w Activity Strip). */
export const enqueueAgentTurn: MessageHandler = async ({
  deps,
  auth,
  conversation,
  message,
  requestId,
}) => {
  const taskId = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, async (c) => {
    await emitEvent(c, {
      householdId: auth.householdId!,
      ownerUserId: auth.userId,
      visibility: conversation.visibility,
      type: 'message.created',
      payload: { conversationId: conversation.id, messageId: message.id, role: 'user' },
    });
    return createTask(c, {
      householdId: auth.householdId!,
      visibility: conversation.visibility,
      conversationId: conversation.id,
      kind: 'agent.turn',
      title: `Odpowiedź: „${shortText(message.content, 50)}”`,
      input: { messageId: message.id },
      steps: [{ key: 'reply', title: 'Odpowiedź asystenta', kind: 'model' }],
      requestId,
    });
  });
  deps.kickQueue();
  return { taskId };
};

export const conversationRoutes =
  (deps: AppDeps, onUserMessage?: MessageHandler): FastifyPluginAsync =>
  async (app) => {
    app.get('/conversations', async (req) => {
      const auth = requireAuth(req);
      const q = parse(ListConversationsQuery, req.query);
      const cursor = decodeCursor(q.cursor);
      const rows = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, async (c) => {
        const params: unknown[] = [q.limit + 1];
        const conds: string[] = ['c.archived_at IS NULL'];
        if (q.space === 'private') {
          conds.push(`c.visibility = 'private'`, 'c.owner_user_id = nova_uid()');
        } else {
          params.push(auth.householdId);
          conds.push(`c.visibility = 'shared'`, `c.household_id = $${params.length}`);
        }
        if (cursor) {
          params.push(cursor.ts, cursor.id);
          conds.push(
            `(c.updated_at, c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
          );
        }
        const r = await c.query<ConversationRow>(
          `${CONV_SELECT} WHERE ${conds.join(' AND ')} ORDER BY c.updated_at DESC, c.id DESC LIMIT $1`,
          params,
        );
        return r.rows;
      });
      const page = pageResult(rows.map(toConversation), q.limit, (x) => x.updatedAt);
      return page;
    });

    app.post('/conversations', async (req, reply) => {
      const auth = requireAuth(req);
      const body = parse(CreateConversationRequest, req.body);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      const decision = decideCreate(actorFor(auth), 'conversation.create', {
        householdId: auth.householdId,
        visibility: body.space,
      });
      if (!decision.allow) throw forbidden();
      const conversation = await withUserTx(
        deps.db,
        { userId: auth.userId, scope: 'user' },
        async (c) => {
          // Agenta wyznacza serwer: prywatna => prywatny agent właściciela; wspólna => NovaAI.
          const agent = await c.query<{ id: string }>(
            body.space === 'private'
              ? `SELECT id FROM agents WHERE household_id = $1 AND kind = 'private' AND owner_user_id = nova_uid()`
              : `SELECT id FROM agents WHERE household_id = $1 AND kind = 'household'`,
            [auth.householdId],
          );
          if (!agent.rows[0]) throw notFound('Agent');
          const ins = await c.query<{ id: string }>(
            `INSERT INTO conversations (household_id, owner_user_id, agent_id, visibility, title)
           VALUES ($1, nova_uid(), $2, $3, $4) RETURNING id`,
            [
              auth.householdId,
              agent.rows[0].id,
              body.space,
              body.title ?? (body.space === 'shared' ? 'Wspólna rozmowa' : 'Nowa rozmowa'),
            ],
          );
          return fetchConversation(c, ins.rows[0]!.id);
        },
      );
      await writeAudit(deps.db, {
        actorKind: 'user',
        actorUserId: auth.userId,
        ownerUserId: auth.userId,
        householdId: auth.householdId,
        source: 'api',
        action: 'conversation.create',
        resourceType: 'conversation',
        resourceId: conversation!.id,
        outcome: 'ok',
        correlationId: req.id,
        details: { visibility: body.space },
      });
      return reply.status(201).send(conversation);
    });

    app.get<{ Params: { id: string } }>('/conversations/:id', async (req) => {
      const auth = requireAuth(req);
      await authorize(deps.db, req, 'conversation', req.params.id, 'conversation.read');
      const conv = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, (c) =>
        fetchConversation(c, req.params.id),
      );
      if (!conv) throw notFound('Conversation');
      return conv;
    });

    app.get<{ Params: { id: string } }>('/conversations/:id/messages', async (req) => {
      const auth = requireAuth(req);
      await authorize(deps.db, req, 'conversation', req.params.id, 'conversation.read');
      const q = parse(PageQuery, req.query);
      const cursor = decodeCursor(q.cursor);
      const rows = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, async (c) => {
        const params: unknown[] = [req.params.id, q.limit + 1];
        let where = 'm.conversation_id = $1';
        if (cursor) {
          params.push(cursor.ts, cursor.id);
          where += ` AND (m.created_at, m.id) < ($3::timestamptz, $4::uuid)`;
        }
        const r = await c.query<MessageRow>(
          `${MESSAGE_SELECT} WHERE ${where} ORDER BY m.created_at DESC, m.id DESC LIMIT $2`,
          params,
        );
        return r.rows.map(toMessage);
      });
      // Strona zawiera najnowsze wiadomości; nextCursor prowadzi do starszych. Zwracamy chronologicznie.
      const page = pageResult(rows, q.limit, (m) => m.createdAt);
      return { items: page.items.reverse(), nextCursor: page.nextCursor };
    });

    app.post<{ Params: { id: string } }>('/conversations/:id/messages', async (req, reply) => {
      const auth = requireAuth(req);
      await authorize(deps.db, req, 'conversation', req.params.id, 'conversation.write');
      const body = parse(PostMessageRequest, req.body);
      const { conversation, message } = await withUserTx(
        deps.db,
        { userId: auth.userId, scope: 'user' },
        async (c) => {
          const conv = await fetchConversation(c, req.params.id);
          if (!conv) throw notFound('Conversation');
          const msg = await insertMessage(c, {
            conversationId: conv.id,
            role: 'user',
            authorUserId: auth.userId,
            content: body.content,
            requestId: req.id,
          });
          // Rozmowa z domyślnym tytułem dostaje tytuł z pierwszej wiadomości (lista nie jest ciągiem „Nowa rozmowa”).
          if (DEFAULT_TITLES.has(conv.title)) {
            const r = await c.query<{ title: string }>(
              `UPDATE conversations SET title = $2 WHERE id = $1
                 AND NOT EXISTS (SELECT 1 FROM messages m
                                  WHERE m.conversation_id = $1 AND m.role = 'user' AND m.id <> $3)
               RETURNING title`,
              [conv.id, shortText(body.content, 60), msg.id],
            );
            if (r.rows[0]) conv.title = r.rows[0].title;
          }
          return { conversation: conv, message: msg };
        },
      );
      const { taskId } = onUserMessage
        ? await onUserMessage({ deps, auth, conversation, message, requestId: req.id })
        : { taskId: null };
      return reply.status(201).send({ message, taskId });
    });
  };
