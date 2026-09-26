import { CreateTaskRequest, ListTasksQuery, type Task, type TaskStep } from '@nova/contracts';
import { decideCreate } from '@nova/permissions';
import type { FastifyPluginAsync } from 'fastify';
import type pg from 'pg';
import { actorFor, authorize, requireAuth } from '../access';
import { writeAudit } from '../audit';
import { withSystemTx, withUserTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { emitEvent } from '../events';
import { decodeCursor, pageResult } from '../lib/cursor';
import { conflict, forbidden, notFound } from '../lib/errors';
import { parse } from '../lib/validate';
import { demoWorkflowSteps } from '../queue/kinds';
import { createTask } from '../queue/tasks';

interface TaskRow {
  id: string;
  kind: string;
  title: string;
  status: Task['status'];
  visibility: Task['visibility'];
  owner_user_id: string;
  conversation_id: string | null;
  progress: number | null;
  attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

interface StepRow {
  id: string;
  seq: number;
  key: string;
  title: string;
  kind: TaskStep['kind'];
  tool: string | null;
  depends_on: string[];
  requires_approval: boolean;
  status: TaskStep['status'];
  approval_id: string | null;
  progress: number | null;
  output: Record<string, unknown> | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

const TASK_SELECT = `SELECT id, kind, title, status, visibility, owner_user_id, conversation_id, progress, attempts,
  error, created_at, updated_at, finished_at FROM tasks`;

const toTask = (r: TaskRow, me: string): Task => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  status: r.status,
  visibility: r.visibility,
  ownerUserId: r.owner_user_id,
  isMine: r.owner_user_id === me,
  conversationId: r.conversation_id,
  progress: r.progress,
  attempts: r.attempts,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  finishedAt: r.finished_at,
});

const toStep = (r: StepRow): TaskStep => ({
  id: r.id,
  seq: r.seq,
  key: r.key,
  title: r.title,
  kind: r.kind,
  tool: r.tool,
  dependsOn: r.depends_on,
  requiresApproval: r.requires_approval,
  status: r.status,
  approvalId: r.approval_id,
  progress: r.progress,
  output: r.output,
  error: r.error,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

async function fetchTask(c: pg.PoolClient, id: string, me: string): Promise<Task | null> {
  const t = await c.query<TaskRow>(`${TASK_SELECT} WHERE id = $1`, [id]);
  if (!t.rows[0]) return null;
  const s = await c.query<StepRow>(
    `SELECT id, seq, key, title, kind, tool, depends_on, requires_approval, status, approval_id, progress, output,
            error, started_at, finished_at
       FROM task_steps WHERE task_id = $1 ORDER BY seq`,
    [id],
  );
  return { ...toTask(t.rows[0], me), steps: s.rows.map(toStep) };
}

export const taskRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get('/tasks', async (req) => {
      const auth = requireAuth(req);
      const q = parse(ListTasksQuery, req.query);
      const cursor = decodeCursor(q.cursor);
      const rows = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, async (c) => {
        const params: unknown[] = [q.limit + 1];
        const conds: string[] = [];
        if (q.space === 'private')
          conds.push(`visibility = 'private'`, 'owner_user_id = nova_uid()');
        else {
          params.push(auth.householdId);
          conds.push(`visibility = 'shared'`, `household_id = $${params.length}`);
        }
        if (q.status === 'active') conds.push(`status IN ('queued','running','waiting_approval')`);
        if (cursor) {
          params.push(cursor.ts, cursor.id);
          conds.push(
            `(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
          );
        }
        const r = await c.query<TaskRow>(
          `${TASK_SELECT} WHERE ${conds.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $1`,
          params,
        );
        return r.rows.map((x) => toTask(x, auth.userId));
      });
      return pageResult(rows, q.limit, (t) => t.createdAt);
    });

    app.post('/tasks', async (req, reply) => {
      const auth = requireAuth(req);
      const body = parse(CreateTaskRequest, req.body);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      const d = decideCreate(actorFor(auth), 'task.create', {
        householdId: auth.householdId,
        visibility: body.space,
      });
      if (!d.allow) throw forbidden();
      const task = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, async (c) => {
        const id = await createTask(c, {
          householdId: auth.householdId!,
          visibility: body.space,
          kind: body.kind,
          title: body.title ?? 'Zadanie demonstracyjne',
          input: {},
          steps: demoWorkflowSteps(body.message),
          requestId: req.id,
        });
        return fetchTask(c, id, auth.userId);
      });
      await writeAudit(deps.db, {
        actorKind: 'user',
        actorUserId: auth.userId,
        ownerUserId: auth.userId,
        householdId: auth.householdId,
        source: 'api',
        action: 'task.create',
        resourceType: 'task',
        resourceId: task!.id,
        outcome: 'ok',
        correlationId: req.id,
        details: { kind: body.kind },
      });
      deps.kickQueue();
      return reply.status(201).send(task);
    });

    app.get<{ Params: { id: string } }>('/tasks/:id', async (req) => {
      const auth = requireAuth(req);
      await authorize(deps.db, req, 'task', req.params.id, 'task.read');
      const t = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, (c) =>
        fetchTask(c, req.params.id, auth.userId),
      );
      if (!t) throw notFound('Task');
      return t;
    });

    app.get<{ Params: { id: string } }>('/tasks/:id/steps', async (req) => {
      const auth = requireAuth(req);
      await authorize(deps.db, req, 'task', req.params.id, 'task.read');
      const t = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, (c) =>
        fetchTask(c, req.params.id, auth.userId),
      );
      if (!t) throw notFound('Task');
      return { items: t.steps ?? [] };
    });

    /**
     * Anulowanie: zadanie i otwarte kroki => cancelled, zgody (także zatwierdzone) => invalidated.
     * Kolejka traci dzierżawę przy następnym heartbeat/kroku; broker odmawia wykonania.
     */
    app.post<{ Params: { id: string } }>('/tasks/:id/cancel', async (req) => {
      const auth = requireAuth(req);
      const meta = await authorize(deps.db, req, 'task', req.params.id, 'task.cancel');
      const result = await withSystemTx(deps.db, async (c) => {
        const r = await c.query<{ id: string }>(
          `UPDATE tasks SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
                  finished_at = now(), updated_at = now()
            WHERE id = $1 AND owner_user_id = $2 AND status IN ('queued','running','waiting_approval')
            RETURNING id`,
          [req.params.id, auth.userId],
        );
        if (r.rowCount !== 1) return null;
        await c.query(
          `UPDATE task_steps SET status = 'cancelled', error = 'Anulowano', updated_at = now(), finished_at = now()
            WHERE task_id = $1 AND status NOT IN ('completed','failed','cancelled','skipped')`,
          [req.params.id],
        );
        const inv = await c.query<{ id: string }>(
          `UPDATE approvals SET status = 'invalidated', updated_at = now()
            WHERE task_id = $1 AND status IN ('pending','approved','executing') RETURNING id`,
          [req.params.id],
        );
        await emitEvent(c, {
          householdId: meta.householdId,
          ownerUserId: meta.ownerUserId,
          visibility: meta.visibility,
          taskId: req.params.id,
          type: 'task.status',
          payload: { status: 'cancelled' },
        });
        for (const a of inv.rows) {
          await emitEvent(c, {
            householdId: meta.householdId,
            ownerUserId: meta.ownerUserId,
            visibility: 'private',
            taskId: req.params.id,
            type: 'approval.resolved',
            payload: { approvalId: a.id, status: 'invalidated' },
          });
        }
        return true;
      });
      if (!result) throw conflict('not_cancellable', 'Zadanie jest już zakończone');
      await writeAudit(deps.db, {
        actorKind: 'user',
        actorUserId: auth.userId,
        ownerUserId: meta.ownerUserId,
        householdId: meta.householdId,
        source: 'api',
        action: 'task.cancel',
        resourceType: 'task',
        resourceId: req.params.id,
        outcome: 'ok',
        correlationId: req.id,
      });
      return withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, (c) =>
        fetchTask(c, req.params.id, auth.userId),
      );
    });
  };
