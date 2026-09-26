import type pg from 'pg';
import { emitEvent } from '../events';

export interface StepSpec {
  key: string;
  title: string;
  kind: 'tool' | 'model' | 'note';
  tool?: string | null;
  params?: Record<string, unknown>;
  dependsOn?: string[];
  requiresApproval?: boolean;
}

interface CreateTaskArgs {
  householdId: string;
  visibility: 'private' | 'shared';
  conversationId?: string | null;
  kind: string;
  title: string;
  input?: Record<string, unknown>;
  steps: StepSpec[];
  requestId?: string | null;
  maxAttempts?: number;
}

/**
 * Tworzy zadanie z krokami w transakcji użytkownika (RLS: właściciel = nova_uid()).
 * Zależności kroków są walidowane — cykl lub nieznany klucz to błąd programisty.
 */
export async function createTask(c: pg.PoolClient, a: CreateTaskArgs): Promise<string> {
  const keys = new Set(a.steps.map((s) => s.key));
  if (keys.size !== a.steps.length) throw new Error('Zduplikowane klucze kroków');
  a.steps.forEach((s, i) => {
    for (const d of s.dependsOn ?? []) {
      const idx = a.steps.findIndex((x) => x.key === d);
      if (idx < 0 || idx >= i)
        throw new Error(`Krok ${s.key} zależy od nieznanego lub późniejszego ${d}`);
    }
  });
  const t = await c.query<{ id: string; owner_user_id: string }>(
    `INSERT INTO tasks (household_id, owner_user_id, visibility, conversation_id, kind, title, input, request_id, max_attempts)
     VALUES ($1, nova_uid(), $2, $3, $4, $5, $6, $7, $8) RETURNING id, owner_user_id`,
    [
      a.householdId,
      a.visibility,
      a.conversationId ?? null,
      a.kind,
      a.title,
      JSON.stringify(a.input ?? {}),
      a.requestId ?? null,
      a.maxAttempts ?? 3,
    ],
  );
  const task = t.rows[0]!;
  await insertSteps(c, task.id, a.steps, 0);
  await emitEvent(c, {
    householdId: a.householdId,
    ownerUserId: task.owner_user_id,
    visibility: a.visibility,
    taskId: task.id,
    type: 'task.created',
    payload: {
      title: a.title,
      kind: a.kind,
      status: 'queued',
      conversationId: a.conversationId ?? null,
    },
  });
  return task.id;
}

export async function insertSteps(
  c: pg.PoolClient,
  taskId: string,
  steps: StepSpec[],
  seqStart: number,
): Promise<void> {
  let seq = seqStart;
  for (const s of steps) {
    await c.query(
      `INSERT INTO task_steps (task_id, seq, key, title, kind, tool, params, depends_on, requires_approval)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        taskId,
        seq++,
        s.key,
        s.title,
        s.kind,
        s.tool ?? null,
        JSON.stringify(s.params ?? {}),
        s.dependsOn ?? [],
        s.requiresApproval ?? false,
      ],
    );
  }
}
