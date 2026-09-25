import {
  CreateMemoryRequest,
  ListMemoriesQuery,
  UpdateMemoryRequest,
  type Memory,
} from '@nova/contracts';
import { decideCreate } from '@nova/permissions';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { actorFor, authorize, requireAuth } from '../access';
import { writeAudit } from '../audit';
import { withUserTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { decodeCursor, pageResult } from '../lib/cursor';
import { conflict, forbidden, notFound } from '../lib/errors';
import { parse } from '../lib/validate';

interface MemoryRow {
  id: string;
  kind: Memory['kind'];
  visibility: Memory['visibility'];
  content: string;
  owner_user_id: string;
  owner_name: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

export const MEMORY_SELECT = `
  SELECT m.id, m.kind, m.visibility, m.content, m.owner_user_id, u.display_name AS owner_name, m.source,
         m.created_at, m.updated_at
    FROM memories m LEFT JOIN users u ON u.id = m.owner_user_id`;

const toMemory = (r: MemoryRow, me: string): Memory => ({
  id: r.id,
  kind: r.kind,
  visibility: r.visibility,
  content: r.content,
  ownerUserId: r.owner_user_id,
  ownerName: r.owner_name,
  isMine: r.owner_user_id === me,
  source: r.source,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

async function fetchMemory(c: pg.PoolClient, id: string, me: string): Promise<Memory | null> {
  const { rows } = await c.query<MemoryRow>(`${MEMORY_SELECT} WHERE m.id = $1`, [id]);
  return rows[0] ? toMemory(rows[0], me) : null;
}

/** Tworzy pamięć w kontekście użytkownika (używane też przez broker narzędzi agenta). */
export async function createMemory(
  c: pg.PoolClient,
  args: {
    householdId: string;
    userId: string;
    kind: Memory['kind'];
    content: string;
    shared: boolean;
    source: string;
    sourceConversationId?: string | null;
  },
): Promise<Memory> {
  const ins = await c.query<{ id: string }>(
    `INSERT INTO memories (household_id, owner_user_id, kind, visibility, content, source, source_conversation_id)
     VALUES ($1, nova_uid(), $2, $3, $4, $5, $6) RETURNING id`,
    [
      args.householdId,
      args.kind,
      args.shared ? 'shared' : 'private',
      args.content,
      args.source,
      args.sourceConversationId ?? null,
    ],
  );
  const id = ins.rows[0]!.id;
  if (args.shared) {
    await c.query(
      `INSERT INTO memory_grants (memory_id, household_id, granted_by) VALUES ($1, $2, nova_uid())`,
      [id, args.householdId],
    );
  }
  return (await fetchMemory(c, id, args.userId))!;
}

export const memoryRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const audit = (
      req: FastifyRequest,
      action: string,
      memoryId: string,
      ownerUserId: string,
      householdId: string | null,
      details?: Record<string, unknown>,
    ) =>
      writeAudit(deps.db, {
        actorKind: 'user',
        actorUserId: req.auth!.userId,
        ownerUserId,
        householdId,
        source: 'api',
        action,
        resourceType: 'memory',
        resourceId: memoryId,
        outcome: 'ok',
        correlationId: req.id,
        details,
      });

    app.get('/memories', async (req) => {
      const auth = requireAuth(req);
      const q = parse(ListMemoriesQuery, req.query);
      const cursor = decodeCursor(q.cursor);
      const rows = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, async (c) => {
        const params: unknown[] = [q.limit + 1];
        const conds: string[] = [];
        if (q.space === 'private') {
          conds.push(`m.visibility = 'private'`, 'm.owner_user_id = nova_uid()');
        } else {
          params.push(auth.householdId);
          conds.push(`m.visibility = 'shared'`, `m.household_id = $${params.length}`);
        }
        if (cursor) {
          params.push(cursor.ts, cursor.id);
          conds.push(
            `(m.updated_at, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
          );
        }
        const r = await c.query<MemoryRow>(
          `${MEMORY_SELECT} WHERE ${conds.join(' AND ')} ORDER BY m.updated_at DESC, m.id DESC LIMIT $1`,
          params,
        );
        return r.rows.map((row) => toMemory(row, auth.userId));
      });
      return pageResult(rows, q.limit, (m) => m.updatedAt);
    });

    app.post('/memories', async (req, reply) => {
      const auth = requireAuth(req);
      const body = parse(CreateMemoryRequest, req.body);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      const d = decideCreate(actorFor(auth), 'memory.create', {
        householdId: auth.householdId,
        visibility: body.space,
      });
      if (!d.allow) throw forbidden();
      const memory = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, (c) =>
        createMemory(c, {
          householdId: auth.householdId!,
          userId: auth.userId,
          kind: body.kind,
          content: body.content,
          shared: body.space === 'shared',
          source: 'user',
        }),
      );
      await audit(req, 'memory.create', memory.id, auth.userId, auth.householdId);
      if (body.space === 'shared') {
        await audit(req, 'memory.share', memory.id, auth.userId, auth.householdId, {
          at: 'create',
        });
      }
      return reply.status(201).send(memory);
    });

    app.patch<{ Params: { id: string } }>('/memories/:id', async (req) => {
      const auth = requireAuth(req);
      const meta = await authorize(deps.db, req, 'memory', req.params.id, 'memory.update');
      const body = parse(UpdateMemoryRequest, req.body);
      const memory = await withUserTx(
        deps.db,
        { userId: auth.userId, scope: 'user' },
        async (c) => {
          const r = await c.query(
            `UPDATE memories SET content = $2, updated_at = now() WHERE id = $1`,
            [req.params.id, body.content],
          );
          if (r.rowCount !== 1) throw notFound('Memory');
          return fetchMemory(c, req.params.id, auth.userId);
        },
      );
      await audit(req, 'memory.update', req.params.id, meta.ownerUserId, meta.householdId);
      return memory;
    });

    app.post<{ Params: { id: string } }>('/memories/:id/share', async (req) => {
      const auth = requireAuth(req);
      const meta = await authorize(deps.db, req, 'memory', req.params.id, 'memory.share');
      const memory = await withUserTx(
        deps.db,
        { userId: auth.userId, scope: 'user' },
        async (c) => {
          const cur = await c.query<{ visibility: string }>(
            'SELECT visibility FROM memories WHERE id = $1 FOR UPDATE',
            [req.params.id],
          );
          if (!cur.rows[0]) throw notFound('Memory');
          const active = await c.query(
            'SELECT 1 FROM memory_grants WHERE memory_id = $1 AND revoked_at IS NULL',
            [req.params.id],
          );
          if (cur.rows[0].visibility === 'shared' && active.rowCount === 1) {
            throw conflict('already_shared', 'Pamięć jest już udostępniona');
          }
          await c.query(
            `UPDATE memories SET visibility = 'shared', updated_at = now() WHERE id = $1`,
            [req.params.id],
          );
          await c.query(
            `INSERT INTO memory_grants (memory_id, household_id, granted_by) VALUES ($1, $2, nova_uid())`,
            [req.params.id, meta.householdId],
          );
          return fetchMemory(c, req.params.id, auth.userId);
        },
      );
      await audit(req, 'memory.share', req.params.id, meta.ownerUserId, meta.householdId);
      return memory;
    });

    app.post<{ Params: { id: string } }>('/memories/:id/unshare', async (req) => {
      const auth = requireAuth(req);
      // Odczyt metadanych bez warunku grantu: właściciel może cofnąć także „zawieszone” udostępnienie.
      const meta = await authorize(deps.db, req, 'memory', req.params.id, 'memory.unshare');
      const memory = await withUserTx(
        deps.db,
        { userId: auth.userId, scope: 'user' },
        async (c) => {
          const cur = await c.query('SELECT 1 FROM memories WHERE id = $1 FOR UPDATE', [
            req.params.id,
          ]);
          if (cur.rowCount !== 1) throw notFound('Memory');
          const r = await c.query(
            `UPDATE memory_grants SET revoked_at = now(), revoked_by = nova_uid()
            WHERE memory_id = $1 AND revoked_at IS NULL`,
            [req.params.id],
          );
          await c.query(
            `UPDATE memories SET visibility = 'private', updated_at = now() WHERE id = $1`,
            [req.params.id],
          );
          if (r.rowCount === 0 && meta.visibility === 'private') {
            throw conflict('not_shared', 'Pamięć nie jest udostępniona');
          }
          return fetchMemory(c, req.params.id, auth.userId);
        },
      );
      await audit(req, 'memory.unshare', req.params.id, meta.ownerUserId, meta.householdId);
      return memory;
    });

    app.delete<{ Params: { id: string } }>('/memories/:id', async (req, reply) => {
      const auth = requireAuth(req);
      const meta = await authorize(deps.db, req, 'memory', req.params.id, 'memory.delete');
      await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, async (c) => {
        const r = await c.query('DELETE FROM memories WHERE id = $1', [req.params.id]);
        if (r.rowCount !== 1) throw notFound('Memory');
      });
      await audit(req, 'memory.delete', req.params.id, meta.ownerUserId, meta.householdId);
      return reply.status(204).send();
    });
  };
