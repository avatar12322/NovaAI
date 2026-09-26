import type pg from 'pg';
import { withSystemTx } from '../db/pool';
import { emitEvent } from '../events';
import { createTask } from '../queue/tasks';
import type { TaskKindDef } from '../queue/runner';
import { ToolDenied } from '../tools/types';

const MAX_ACTIVE_REMINDERS = 50;
export const MAX_AHEAD_MS = 366 * 24 * 3600_000;

interface NewReminder {
  householdId: string;
  visibility: 'private' | 'shared';
  text: string;
  dueAt: Date;
  source: string;
  requestId?: string | null;
}

export class ReminderError extends Error {
  constructor(
    public readonly code: 'too_many' | 'bad_time',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Utworzenie przypomnienia w transakcji użytkownika (RLS): rekord + zadanie `reminder.fire`
 * z `run_after = due_at` — trwała kolejka dostarcza je także po restarcie.
 */
export async function createReminder(
  c: pg.PoolClient,
  r: NewReminder,
): Promise<{ id: string; taskId: string }> {
  const now = Date.now();
  if (
    Number.isNaN(r.dueAt.getTime()) ||
    r.dueAt.getTime() < now - 60_000 ||
    r.dueAt.getTime() > now + MAX_AHEAD_MS
  ) {
    throw new ReminderError(
      'bad_time',
      'Termin przypomnienia musi być w przyszłości (maks. 1 rok)',
    );
  }
  const active = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM reminders WHERE owner_user_id = nova_uid() AND status = 'scheduled'`,
  );
  if ((active.rows[0]?.n ?? 0) >= MAX_ACTIVE_REMINDERS) {
    throw new ReminderError('too_many', `Limit ${MAX_ACTIVE_REMINDERS} aktywnych przypomnień`);
  }
  const ins = await c.query<{ id: string }>(
    `INSERT INTO reminders (household_id, owner_user_id, visibility, text, due_at, source)
     VALUES ($1, nova_uid(), $2, $3, $4, $5) RETURNING id`,
    [r.householdId, r.visibility, r.text, r.dueAt, r.source],
  );
  const id = ins.rows[0]!.id;
  const taskId = await createTask(c, {
    householdId: r.householdId,
    visibility: r.visibility,
    kind: 'reminder.fire',
    title: r.visibility === 'shared' ? 'Przypomnienie wspólne' : 'Przypomnienie',
    input: { reminderId: id },
    steps: [{ key: 'deliver', title: 'Dostarczenie przypomnienia', kind: 'note' }],
    requestId: r.requestId ?? null,
  });
  await c.query(`UPDATE tasks SET run_after = $2 WHERE id = $1`, [taskId, r.dueAt]);
  await c.query(`UPDATE reminders SET task_id = $2 WHERE id = $1`, [id, taskId]);
  return { id, taskId };
}

/**
 * Dostarczenie: deterministyczne, bez modelu (działa także przy zablokowanym budżecie).
 * Prywatne przypomnienie trafia WYŁĄCZNIE do właściciela; wspólne — do aktywnych członków domu.
 */
export const reminderFireKind: TaskKindDef = {
  context: async () => 'user',
  steps: {
    deliver: async (x) => {
      const reminderId = String(x.task.input.reminderId ?? '');
      return withSystemTx(x.deps.db, async (c) => {
        const r = await c.query<{
          id: string;
          household_id: string;
          owner_user_id: string;
          visibility: 'private' | 'shared';
          text: string;
          status: string;
        }>(
          `SELECT id, household_id, owner_user_id, visibility, text, status FROM reminders WHERE id = $1 FOR UPDATE`,
          [reminderId],
        );
        const rem = r.rows[0];
        if (!rem) throw new ToolDenied('reminder_missing');
        if (rem.status !== 'scheduled') return { delivered: 0, skipped: rem.status };
        if (rem.owner_user_id !== x.principal.userId) throw new ToolDenied('owner_mismatch');
        const recipients =
          rem.visibility === 'shared'
            ? (
                await c.query<{ user_id: string }>(
                  `SELECT user_id FROM memberships WHERE household_id = $1 AND status = 'active'`,
                  [rem.household_id],
                )
              ).rows.map((m) => m.user_id)
            : [rem.owner_user_id];
        for (const uid of recipients) {
          const n = await c.query<{ id: string }>(
            `INSERT INTO notifications (household_id, user_id, kind, title, body, ref_type, ref_id, idempotency_key)
             VALUES ($1, $2, 'reminder', $3, $4, 'reminder', $5, $6)
             ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
            [
              rem.household_id,
              uid,
              rem.visibility === 'shared' ? 'Przypomnienie (wspólne)' : 'Przypomnienie',
              rem.text,
              rem.id,
              `reminder:${rem.id}:${uid}`,
            ],
          );
          if (n.rows[0]) {
            await emitEvent(c, {
              householdId: rem.household_id,
              ownerUserId: uid,
              visibility: 'private',
              type: 'notification.created',
              payload: { notificationId: n.rows[0].id, kind: 'reminder' },
            });
          }
        }
        await c.query(`UPDATE reminders SET status = 'fired', fired_at = now() WHERE id = $1`, [
          rem.id,
        ]);
        return { delivered: recipients.length };
      });
    },
  },
};
