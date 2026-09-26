import type pg from 'pg';
import { emitEvent } from '../events';
import type { PlannedCall } from '../tools/broker';

const APPROVAL_TTL_MS = 24 * 3600_000;

interface ApprovalTarget {
  taskId: string;
  stepId: string;
  householdId: string;
  ownerUserId: string;
  visibility: 'private' | 'shared';
  taskTitle: string;
}

/**
 * Tworzy zgodę na DOKŁADNIE zaplanowaną akcję (zamrożone parametry + skrót). Wywoływane rolą systemową.
 */
export async function createApproval(
  c: pg.PoolClient,
  t: ApprovalTarget,
  planned: PlannedCall,
  ttlMs = APPROVAL_TTL_MS,
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO approvals (household_id, owner_user_id, task_id, step_id, tool, capability, action, action_hash,
       summary, target, scope, diff, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now() + ($13::bigint * interval '1 millisecond'))
     RETURNING id`,
    [
      t.householdId,
      t.ownerUserId,
      t.taskId,
      t.stepId,
      planned.tool,
      planned.capability,
      JSON.stringify(planned.params),
      planned.actionHash,
      planned.preview.summary,
      planned.preview.target,
      planned.preview.scope,
      planned.preview.diff ?? null,
      ttlMs,
    ],
  );
  const approvalId = r.rows[0]!.id;
  await c.query(
    `UPDATE task_steps SET status = 'waiting_approval', approval_id = $2, updated_at = now() WHERE id = $1`,
    [t.stepId, approvalId],
  );
  // Zgoda jest zawsze prywatna dla zatwierdzającego; drugi domownik widzi tylko status kroku (jeśli zadanie wspólne).
  await emitEvent(c, {
    householdId: t.householdId,
    ownerUserId: t.ownerUserId,
    visibility: 'private',
    taskId: t.taskId,
    type: 'approval.requested',
    payload: {
      approvalId,
      stepId: t.stepId,
      taskTitle: t.taskTitle,
      summary: planned.preview.summary,
    },
  });
  await emitEvent(c, {
    householdId: t.householdId,
    ownerUserId: t.ownerUserId,
    visibility: t.visibility,
    taskId: t.taskId,
    type: 'step.status',
    payload: { stepId: t.stepId, status: 'waiting_approval' },
  });
  return approvalId;
}
