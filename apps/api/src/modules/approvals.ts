import { ApproveRequest, ListApprovalsQuery, RejectRequest, type Approval } from '@nova/contracts';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { authorize, requireAuth } from '../access';
import { writeAudit } from '../audit';
import { withSystemTx, withUserTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { emitEvent } from '../events';
import { decodeCursor, pageResult } from '../lib/cursor';
import { HttpError, notFound } from '../lib/errors';
import { parse } from '../lib/validate';

interface ApprovalRow {
  id: string;
  task_id: string;
  step_id: string;
  task_title: string;
  tool: string;
  capability: string;
  action: Record<string, unknown>;
  action_hash: string;
  summary: string;
  target: string;
  scope: string;
  diff: string | null;
  status: Approval['status'];
  expires_at: string;
  resolved_at: string | null;
  executed_at: string | null;
  created_at: string;
}

const APPROVAL_SELECT = `SELECT a.id, a.task_id, a.step_id, t.title AS task_title, a.tool, a.capability, a.action,
  a.action_hash, a.summary, a.target, a.scope, a.diff, a.status, a.expires_at, a.resolved_at, a.executed_at,
  a.created_at
  FROM approvals a JOIN tasks t ON t.id = a.task_id`;

const toApproval = (r: ApprovalRow): Approval => ({
  id: r.id,
  taskId: r.task_id,
  stepId: r.step_id,
  taskTitle: r.task_title,
  tool: r.tool,
  capability: r.capability,
  action: r.action,
  actionHash: r.action_hash,
  summary: r.summary,
  target: r.target,
  scope: r.scope,
  diff: r.diff,
  status: r.status,
  expiresAt: r.expires_at,
  resolvedAt: r.resolved_at,
  executedAt: r.executed_at,
  createdAt: r.created_at,
});

export const approvalRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const load = (userId: string, id: string) =>
      withUserTx(deps.db, { userId, scope: 'user' }, async (c) => {
        const r = await c.query<ApprovalRow>(`${APPROVAL_SELECT} WHERE a.id = $1`, [id]);
        return r.rows[0] ? toApproval(r.rows[0]) : null;
      });

    app.get('/approvals', async (req) => {
      const auth = requireAuth(req);
      const q = parse(ListApprovalsQuery, req.query);
      const cursor = decodeCursor(q.cursor);
      const rows = await withUserTx(deps.db, { userId: auth.userId, scope: 'user' }, async (c) => {
        const params: unknown[] = [q.limit + 1];
        const conds = ['a.owner_user_id = nova_uid()'];
        if (q.status === 'pending') conds.push(`a.status = 'pending'`, 'a.expires_at > now()');
        if (cursor) {
          params.push(cursor.ts, cursor.id);
          conds.push(
            `(a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
          );
        }
        const r = await c.query<ApprovalRow>(
          `${APPROVAL_SELECT} WHERE ${conds.join(' AND ')} ORDER BY a.created_at DESC, a.id DESC LIMIT $1`,
          params,
        );
        return r.rows.map(toApproval);
      });
      return pageResult(rows, q.limit, (a) => a.createdAt);
    });

    app.get<{ Params: { id: string } }>('/approvals/:id', async (req) => {
      const auth = requireAuth(req);
      await authorize(deps.db, req, 'approval', req.params.id, 'approval.read');
      const a = await load(auth.userId, req.params.id);
      if (!a) throw notFound('Approval');
      return a;
    });

    /**
     * Rozstrzygnięcie zgody. Atomowe przejście pending => approved/rejected warunkowane skrótem akcji
     * (klient zatwierdza konkretną wersję) i czasem wygaśnięcia. Wyścig dwóch żądań: wygrywa jedno.
     */
    async function resolve(
      req: FastifyRequest<{ Params: { id: string } }>,
      decision: 'approved' | 'rejected',
    ) {
      const auth = requireAuth(req);
      const meta = await authorize(deps.db, req, 'approval', req.params.id, 'approval.resolve');
      let hash: string | null = null;
      let reason: string | null = null;
      if (decision === 'approved') hash = parse(ApproveRequest, req.body).actionHash;
      else reason = parse(RejectRequest, req.body).reason ?? null;

      const outcome = await withSystemTx(deps.db, async (c) => {
        const r = await c.query<{ task_id: string }>(
          `UPDATE approvals SET status = $2, resolved_by = $3, resolved_at = now(), updated_at = now(), reason = $5
            WHERE id = $1 AND owner_user_id = $3 AND status = 'pending' AND expires_at > now()
              AND ($4::text IS NULL OR action_hash = $4)
            RETURNING task_id`,
          [req.params.id, decision, auth.userId, hash, reason],
        );
        if (r.rowCount !== 1) {
          const cur = await c.query<{ status: string; action_hash: string; expired: boolean }>(
            `SELECT status, action_hash, expires_at <= now() AS expired FROM approvals WHERE id = $1`,
            [req.params.id],
          );
          const x = cur.rows[0];
          if (!x) return { error: new HttpError(404, 'not_found', 'Zgoda nie istnieje') };
          if (x.status !== 'pending') {
            return {
              error: new HttpError(409, 'already_resolved', `Zgoda ma już status: ${x.status}`),
            };
          }
          if (x.expired) return { error: new HttpError(409, 'expired', 'Zgoda wygasła') };
          return {
            error: new HttpError(409, 'action_changed', 'Akcja różni się od zatwierdzanej wersji'),
          };
        }
        const taskId = r.rows[0]!.task_id;
        await emitEvent(c, {
          householdId: meta.householdId,
          ownerUserId: auth.userId,
          visibility: 'private',
          taskId,
          type: 'approval.resolved',
          payload: { approvalId: req.params.id, status: decision },
        });
        const t = await c.query<{ visibility: 'private' | 'shared' }>(
          `UPDATE tasks SET status = 'queued', run_after = now(), updated_at = now()
            WHERE id = $1 AND status = 'waiting_approval' RETURNING visibility`,
          [taskId],
        );
        if (t.rows[0]) {
          await emitEvent(c, {
            householdId: meta.householdId,
            ownerUserId: auth.userId,
            visibility: t.rows[0].visibility,
            taskId,
            type: 'task.status',
            payload: { status: 'queued' },
          });
        }
        return { error: null };
      });
      await writeAudit(deps.db, {
        actorKind: 'user',
        actorUserId: auth.userId,
        ownerUserId: meta.ownerUserId,
        householdId: meta.householdId,
        source: 'api',
        action: decision === 'approved' ? 'approval.approve' : 'approval.reject',
        resourceType: 'approval',
        resourceId: req.params.id,
        outcome: outcome.error ? 'deny' : 'ok',
        correlationId: req.id,
        details: outcome.error ? { reason: outcome.error.code } : {},
      });
      if (outcome.error) throw outcome.error;
      deps.kickQueue();
      return load(auth.userId, req.params.id);
    }

    app.post<{ Params: { id: string } }>('/approvals/:id/approve', (req) =>
      resolve(req, 'approved'),
    );
    app.post<{ Params: { id: string } }>('/approvals/:id/reject', (req) =>
      resolve(req, 'rejected'),
    );
  };
