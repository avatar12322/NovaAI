import { randomUUID } from 'node:crypto';
import type { ContextKind } from '@nova/permissions';
import type pg from 'pg';
import { writeAudit } from '../audit';
import { withSystemTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { emitEvent } from '../events';
import { loadPrincipal, type Principal } from '../principal';
import { actionHash } from '../tools/broker';
import { ToolDenied, type ToolContext } from '../tools/types';
import { createApproval } from './approvals';
import { insertSteps, type StepSpec } from './tasks';

export interface TaskRow {
  id: string;
  household_id: string;
  owner_user_id: string;
  visibility: 'private' | 'shared';
  conversation_id: string | null;
  kind: string;
  title: string;
  status: string;
  input: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  request_id: string | null;
}

export interface StepRow {
  id: string;
  task_id: string;
  seq: number;
  key: string;
  title: string;
  kind: 'tool' | 'model' | 'note';
  tool: string | null;
  params: Record<string, unknown>;
  depends_on: string[];
  requires_approval: boolean;
  status: string;
  approval_id: string | null;
  attempts: number;
}

export interface StepExecution {
  deps: RunnerDeps;
  task: TaskRow;
  step: StepRow;
  principal: Principal;
  context: ContextKind;
  toolContext: ToolContext;
  isAborted(): boolean;
  progress(pct: number): Promise<void>;
  /** Dołączenie nowych kroków (np. narzędzia zaproponowane przez model). */
  appendSteps(steps: StepSpec[]): Promise<void>;
}

export type StepHandler = (x: StepExecution) => Promise<Record<string, unknown>>;

export interface TaskKindDef {
  /** Kontekst agenta dla zadania — wyznaczany serwerowo z danych w bazie. */
  context(deps: RunnerDeps, task: TaskRow): Promise<ContextKind>;
  /** Handlery kroków `model`/`note` wg klucza kroku; kroki `tool` obsługuje broker. */
  steps: Record<string, StepHandler>;
}

export type RunnerDeps = AppDeps;

export interface RunnerOptions {
  workerId?: string;
  leaseMs: number;
  pollMs?: number;
  concurrency?: number;
  maxStepAttempts?: number;
  /** Bazowy czas ponowienia (ms) — rośnie wykładniczo. */
  retryBaseMs?: number;
}

const TERMINAL_STEP = new Set(['completed', 'failed', 'cancelled', 'skipped']);
const BAD_DEP = new Set(['failed', 'cancelled', 'skipped']);

type StepOutcome = 'continue' | 'abort' | 'retry_later';

/**
 * Trwała kolejka zadań w Postgres: claim przez FOR UPDATE SKIP LOCKED, dzierżawa (lease) z heartbeat,
 * odzysk po restarcie, ponowienia z backoffem. Niezależne kroki działają, gdy inne czekają na zgodę.
 */
export class TaskRunner {
  readonly workerId: string;
  private readonly kinds = new Map<string, TaskKindDef>();
  private running = false;
  private loops: Promise<void>[] = [];
  private wake: (() => void) | null = null;
  private lastRecover = 0;

  constructor(
    private readonly deps: RunnerDeps,
    private readonly opts: RunnerOptions,
  ) {
    this.workerId = opts.workerId ?? `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
  }

  registerKind(kind: string, def: TaskKindDef): this {
    this.kinds.set(kind, def);
    return this;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const n = this.opts.concurrency ?? 2;
    for (let i = 0; i < n; i++) this.loops.push(this.loop());
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await Promise.all(this.loops);
    this.loops = [];
  }

  /** Obudzenie pętli po utworzeniu zadania w tym samym procesie. */
  kick(): void {
    this.wake?.();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        if (Date.now() - this.lastRecover > Math.min(5000, this.opts.leaseMs / 2)) {
          this.lastRecover = Date.now();
          await this.recover();
        }
        const did = await this.runOnce();
        if (did) continue;
      } catch (err) {
        console.error('[queue] loop error', (err as Error).message);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.opts.pollMs ?? 500);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
  }

  /** Przetwarza zadania aż do opróżnienia kolejki (testy, CLI). */
  async drain(maxTasks = 100): Promise<number> {
    let n = 0;
    await this.recover();
    while (n < maxTasks && (await this.runOnce())) n++;
    return n;
  }

  /**
   * Odzysk: zadania z wygasłą dzierżawą wracają do kolejki (lub failed po max_attempts),
   * przerwane kroki wracają do `pending`; przeterminowane zgody => expired i zadanie do kolejki.
   */
  async recover(): Promise<{ requeued: number; failed: number; expired: number }> {
    return withSystemTx(this.deps.db, async (c) => {
      const expired = await c.query<{
        id: string;
        task_id: string;
        household_id: string;
        owner_user_id: string;
      }>(
        `UPDATE approvals SET status = 'expired', updated_at = now()
          WHERE status = 'pending' AND expires_at <= now()
          RETURNING id, task_id, household_id, owner_user_id`,
      );
      for (const a of expired.rows) {
        await emitEvent(c, {
          householdId: a.household_id,
          ownerUserId: a.owner_user_id,
          visibility: 'private',
          taskId: a.task_id,
          type: 'approval.resolved',
          payload: { approvalId: a.id, status: 'expired' },
        });
        await c.query(
          `UPDATE tasks SET status = 'queued', run_after = now(), updated_at = now()
            WHERE id = $1 AND status = 'waiting_approval'`,
          [a.task_id],
        );
      }
      const stale = await c.query<TaskRow & { lease_expirations: number }>(
        `SELECT * FROM tasks WHERE status = 'running' AND lease_expires_at < now() FOR UPDATE SKIP LOCKED`,
      );
      let requeued = 0;
      let failed = 0;
      for (const t of stale.rows) {
        await c.query(
          `UPDATE task_steps SET status = 'pending', updated_at = now() WHERE task_id = $1 AND status = 'running'`,
          [t.id],
        );
        const giveUp = t.lease_expirations + 1 >= t.max_attempts;
        await c.query(
          `UPDATE tasks SET status = $2, lease_owner = NULL, lease_expires_at = NULL,
                  lease_expirations = lease_expirations + 1, updated_at = now(),
                  error = CASE WHEN $2 = 'failed' THEN 'Przekroczono liczbę prób po utracie dzierżawy' ELSE error END,
                  finished_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END
            WHERE id = $1`,
          [t.id, giveUp ? 'failed' : 'queued'],
        );
        await emitEvent(c, {
          householdId: t.household_id,
          ownerUserId: t.owner_user_id,
          visibility: t.visibility,
          taskId: t.id,
          type: 'task.status',
          payload: { status: giveUp ? 'failed' : 'queued', recovered: true },
        });
        if (giveUp) failed++;
        else requeued++;
      }
      return { requeued, failed, expired: expired.rowCount ?? 0 };
    });
  }

  async claim(): Promise<TaskRow | null> {
    return withSystemTx(this.deps.db, async (c) => {
      const r = await c.query<TaskRow>(
        `UPDATE tasks SET status = 'running', lease_owner = $1,
                lease_expires_at = now() + ($2::bigint * interval '1 millisecond'),
                heartbeat_at = now(), attempts = attempts + 1, updated_at = now()
          WHERE id = (
            SELECT id FROM tasks WHERE status = 'queued' AND run_after <= now()
             ORDER BY run_after, created_at FOR UPDATE SKIP LOCKED LIMIT 1)
          RETURNING *`,
        [this.workerId, this.opts.leaseMs],
      );
      const t = r.rows[0];
      if (!t) return null;
      await emitEvent(c, {
        householdId: t.household_id,
        ownerUserId: t.owner_user_id,
        visibility: t.visibility,
        taskId: t.id,
        type: 'task.status',
        payload: { status: 'running' },
      });
      return t;
    });
  }

  async runOnce(): Promise<boolean> {
    const task = await this.claim();
    if (!task) return false;
    await this.process(task);
    return true;
  }

  private startHeartbeat(taskId: string): { lost: () => boolean; stop: () => void } {
    let lost = false;
    const iv = setInterval(
      () => {
        this.deps.db.owner
          .query(
            `UPDATE tasks SET lease_expires_at = now() + ($3::bigint * interval '1 millisecond'), heartbeat_at = now()
              WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
            [taskId, this.workerId, this.opts.leaseMs],
          )
          .then((r) => {
            if (r.rowCount !== 1) lost = true;
          })
          .catch(() => undefined);
      },
      Math.max(200, Math.floor(this.opts.leaseMs / 3)),
    );
    return { lost: () => lost, stop: () => clearInterval(iv) };
  }

  /** Czy nadal posiadamy dzierżawę i zadanie nie zostało anulowane (sprawdzane w bazie). */
  private async stillOwned(taskId: string): Promise<boolean> {
    const r = await this.deps.db.owner.query(
      `SELECT 1 FROM tasks WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
      [taskId, this.workerId],
    );
    return r.rowCount === 1;
  }

  private async process(task: TaskRow): Promise<void> {
    const hb = this.startHeartbeat(task.id);
    try {
      const def = this.kinds.get(task.kind);
      if (!def) {
        await this.finishTask(task, 'failed', `Nieznany rodzaj zadania: ${task.kind}`);
        return;
      }
      const principal = await loadPrincipal(this.deps.db, task.owner_user_id);
      if (!principal || !principal.activeHouseholdIds.has(task.household_id)) {
        await writeAudit(this.deps.db, {
          actorKind: 'system',
          ownerUserId: task.owner_user_id,
          householdId: task.household_id,
          source: 'queue',
          action: 'task.run',
          resourceType: 'task',
          resourceId: task.id,
          outcome: 'deny',
          correlationId: task.request_id,
          details: { reason: 'owner_not_active_member' },
        });
        await this.cancelOpenSteps(task, 'Właściciel nie ma już dostępu');
        await this.finishTask(task, 'failed', 'Właściciel zadania nie ma już dostępu do domu');
        return;
      }
      const context = await def.context(this.deps, task);

      for (let guard = 0; guard < 200; guard++) {
        if (hb.lost() || !(await this.stillOwned(task.id))) return;
        const steps = await this.loadSteps(task.id);
        if (await this.propagate(task, steps)) continue;
        const done = new Set(steps.filter((s) => s.status === 'completed').map((s) => s.key));
        const approvals = await this.approvalStatuses(steps);
        const runnable = steps.find(
          (s) =>
            (s.status === 'pending' && s.depends_on.every((d) => done.has(d))) ||
            (s.status === 'waiting_approval' &&
              s.approval_id !== null &&
              ['approved', 'executing', 'rejected', 'expired', 'invalidated'].includes(
                approvals.get(s.approval_id) ?? '',
              )),
        );
        if (!runnable) break;
        const outcome = await this.runStep(
          def,
          task,
          runnable,
          principal,
          context,
          hb.lost,
          approvals,
        );
        if (outcome === 'abort' || outcome === 'retry_later') return;
      }
      await this.finalize(task);
    } catch (err) {
      console.error('[queue] task error', task.id, (err as Error).message);
      await this.finishTask(task, 'failed', 'Błąd wewnętrzny kolejki').catch(() => undefined);
    } finally {
      hb.stop();
    }
  }

  private async loadSteps(taskId: string): Promise<StepRow[]> {
    const r = await this.deps.db.owner.query<StepRow>(
      'SELECT * FROM task_steps WHERE task_id = $1 ORDER BY seq',
      [taskId],
    );
    return r.rows;
  }

  private async approvalStatuses(steps: StepRow[]): Promise<Map<string, string>> {
    const ids = steps.map((s) => s.approval_id).filter((x): x is string => !!x);
    if (!ids.length) return new Map();
    const r = await this.deps.db.owner.query<{ id: string; status: string }>(
      'SELECT id, status FROM approvals WHERE id = ANY($1::uuid[])',
      [ids],
    );
    return new Map(r.rows.map((x) => [x.id, x.status]));
  }

  /** Kroki zależne od nieudanych/anulowanych => skipped. Zwraca true, jeśli coś zmieniono. */
  private async propagate(task: TaskRow, steps: StepRow[]): Promise<boolean> {
    const byKey = new Map(steps.map((s) => [s.key, s]));
    const toSkip = steps.filter(
      (s) =>
        s.status === 'pending' && s.depends_on.some((d) => BAD_DEP.has(byKey.get(d)?.status ?? '')),
    );
    if (!toSkip.length) return false;
    await withSystemTx(this.deps.db, async (c) => {
      for (const s of toSkip) {
        await this.setStep(c, task, s.id, 'skipped', { error: 'Zależny krok nie został wykonany' });
      }
    });
    return true;
  }

  private async setStep(
    c: pg.PoolClient,
    task: TaskRow,
    stepId: string,
    status: string,
    extra: {
      output?: Record<string, unknown>;
      error?: string | null;
      progress?: number | null;
    } = {},
  ): Promise<void> {
    await c.query(
      `UPDATE task_steps SET status = $2, output = COALESCE($3, output), error = $4,
              progress = COALESCE($5, progress), updated_at = now(),
              finished_at = CASE WHEN $2 IN ('completed','failed','cancelled','skipped') THEN now() ELSE finished_at END
        WHERE id = $1`,
      [
        stepId,
        status,
        extra.output ? JSON.stringify(extra.output) : null,
        extra.error ?? null,
        extra.progress ?? null,
      ],
    );
    await emitEvent(c, {
      householdId: task.household_id,
      ownerUserId: task.owner_user_id,
      visibility: task.visibility,
      taskId: task.id,
      type: 'step.status',
      payload: { stepId, status, error: extra.error ?? null },
    });
  }

  private async runStep(
    def: TaskKindDef,
    task: TaskRow,
    step: StepRow,
    principal: Principal,
    context: ContextKind,
    lost: () => boolean,
    approvals: Map<string, string>,
  ): Promise<StepOutcome> {
    const toolContext: ToolContext = {
      deps: this.deps,
      principal,
      context,
      householdId: task.household_id,
      visibility: task.visibility,
      taskId: task.id,
      stepId: step.id,
      conversationId: task.conversation_id,
      correlationId: task.request_id ?? task.id,
    };

    // 1) Krok wymagający zgody, której jeszcze nie ma: zaplanuj i poproś o zgodę; przejdź do innych kroków.
    if (step.requires_approval && !step.approval_id) {
      if (!step.tool) throw new Error('Krok ze zgodą musi wskazywać narzędzie');
      try {
        const planned = await this.deps.broker.plan(toolContext, {
          tool: step.tool,
          params: step.params,
        });
        await withSystemTx(this.deps.db, async (c) => {
          // Parametry kroku = zamrożone parametry zgody (po prepare()).
          await c.query('UPDATE task_steps SET params = $2 WHERE id = $1', [
            step.id,
            JSON.stringify(planned.params),
          ]);
          await createApproval(
            c,
            {
              taskId: task.id,
              stepId: step.id,
              householdId: task.household_id,
              ownerUserId: task.owner_user_id,
              visibility: task.visibility,
              taskTitle: task.title,
            },
            planned,
          );
        });
      } catch (err) {
        if (!(err instanceof ToolDenied)) throw err;
        await withSystemTx(this.deps.db, (c) =>
          this.setStep(c, task, step.id, 'failed', { error: err.reason }),
        );
      }
      return 'continue';
    }

    // 2) Zgoda odrzucona/wygasła/unieważniona => krok anulowany (bez wykonania).
    const approvalStatus = step.approval_id ? approvals.get(step.approval_id) : undefined;
    if (step.approval_id && ['rejected', 'expired', 'invalidated'].includes(approvalStatus ?? '')) {
      await withSystemTx(this.deps.db, (c) =>
        this.setStep(c, task, step.id, 'cancelled', { error: `Zgoda: ${approvalStatus}` }),
      );
      return 'continue';
    }

    // 3) Start kroku (i konsumpcja zgody) atomowo, pod warunkiem posiadania dzierżawy.
    const started = await withSystemTx(this.deps.db, async (c) => {
      const s = await c.query(
        `UPDATE task_steps s SET status = 'running', started_at = COALESCE(s.started_at, now()),
                attempts = s.attempts + 1, updated_at = now()
           FROM tasks t
          WHERE s.id = $1 AND t.id = s.task_id AND t.status = 'running' AND t.lease_owner = $2
            AND s.status IN ('pending', 'waiting_approval')
          RETURNING s.id`,
        [step.id, this.workerId],
      );
      if (s.rowCount !== 1) return 'abort' as const;
      if (step.approval_id && approvalStatus === 'approved') {
        const hash = actionHash(step.tool ?? '', step.params);
        const a = await c.query(
          `UPDATE approvals SET status = 'executing', updated_at = now()
            WHERE id = $1 AND status = 'approved' AND action_hash = $2 AND expires_at > now()
            RETURNING id`,
          [step.approval_id, hash],
        );
        if (a.rowCount !== 1) {
          // Zmiana parametrów po zatwierdzeniu lub wygaśnięcie => zgoda unieważniona, brak wykonania.
          const cur = await c.query<{ action_hash: string; expires_at: string }>(
            'SELECT action_hash, expires_at FROM approvals WHERE id = $1',
            [step.approval_id],
          );
          const reason = cur.rows[0]?.action_hash !== hash ? 'invalidated' : 'expired';
          await c.query(`UPDATE approvals SET status = $2, updated_at = now() WHERE id = $1`, [
            step.approval_id,
            reason,
          ]);
          await this.setStep(c, task, step.id, 'cancelled', {
            error:
              reason === 'invalidated' ? 'Parametry zmienione po zatwierdzeniu' : 'Zgoda wygasła',
          });
          return 'skip' as const;
        }
      }
      await emitEvent(c, {
        householdId: task.household_id,
        ownerUserId: task.owner_user_id,
        visibility: task.visibility,
        taskId: task.id,
        type: 'step.status',
        payload: { stepId: step.id, status: 'running' },
      });
      return 'ok' as const;
    });
    if (started === 'abort') return 'abort';
    if (started === 'skip') return 'continue';

    const exec: StepExecution = {
      deps: this.deps,
      task,
      step,
      principal,
      context,
      toolContext,
      isAborted: lost,
      progress: async (pct) => {
        const p = Math.max(0, Math.min(100, Math.round(pct)));
        await withSystemTx(this.deps.db, async (c) => {
          await c.query('UPDATE task_steps SET progress = $2 WHERE id = $1', [step.id, p]);
          await emitEvent(c, {
            householdId: task.household_id,
            ownerUserId: task.owner_user_id,
            visibility: task.visibility,
            taskId: task.id,
            type: 'task.progress',
            payload: { stepId: step.id, progress: p },
          });
        });
      },
      appendSteps: async (specs) => {
        if (!specs.length) return;
        await withSystemTx(this.deps.db, async (c) => {
          const r = await c.query<{ max: number | null }>(
            'SELECT max(seq) AS max FROM task_steps WHERE task_id = $1',
            [task.id],
          );
          await insertSteps(c, task.id, specs, (r.rows[0]?.max ?? 0) + 1);
        });
      },
    };

    try {
      let output: Record<string, unknown>;
      if (step.kind === 'tool') {
        if (!step.tool) throw new ToolDenied('no_tool');
        const approval = step.approval_id
          ? await this.deps.db.owner.query<{ execution_id: string }>(
              'SELECT execution_id FROM approvals WHERE id = $1',
              [step.approval_id],
            )
          : null;
        const idempotencyKey = approval?.rows[0]?.execution_id ?? `step:${step.id}`;
        const result = await this.deps.broker.execute(toolContext, step.tool, step.params, {
          idempotencyKey,
          approvalId: step.approval_id,
        });
        output = { summary: result.summary, ...result.output };
      } else {
        const handler = def.steps[step.key] ?? def.steps[`*${step.kind}`];
        if (!handler) throw new ToolDenied('no_handler');
        output = await handler(exec);
      }
      if (lost()) return 'abort';
      await withSystemTx(this.deps.db, async (c) => {
        await this.setStep(c, task, step.id, 'completed', { output, progress: 100 });
        if (step.approval_id) {
          await c.query(
            `UPDATE approvals SET status = 'executed', executed_at = now(), updated_at = now()
              WHERE id = $1 AND status = 'executing'`,
            [step.approval_id],
          );
        }
      });
      return 'continue';
    } catch (err) {
      const denied = err instanceof ToolDenied;
      const maxAttempts = this.opts.maxStepAttempts ?? 3;
      const attempt = step.attempts + 1;
      if (!denied && attempt < maxAttempts) {
        const delay = (this.opts.retryBaseMs ?? 1000) * 2 ** (attempt - 1);
        await withSystemTx(this.deps.db, async (c) => {
          await this.setStep(c, task, step.id, 'pending', {
            error: (err as Error).message.slice(0, 300),
          });
          await c.query(
            `UPDATE tasks SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = now(),
                    run_after = now() + ($3::bigint * interval '1 millisecond')
              WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
            [task.id, this.workerId, delay],
          );
        });
        return 'retry_later';
      }
      await withSystemTx(this.deps.db, async (c) => {
        await this.setStep(c, task, step.id, 'failed', {
          error: denied
            ? `Odmowa: ${(err as ToolDenied).reason}`
            : (err as Error).message.slice(0, 300),
        });
        if (step.approval_id) {
          await c.query(
            `UPDATE approvals SET status = 'failed', updated_at = now() WHERE id = $1 AND status = 'executing'`,
            [step.approval_id],
          );
        }
      });
      return 'continue';
    }
  }

  private async cancelOpenSteps(task: TaskRow, reason: string): Promise<void> {
    await withSystemTx(this.deps.db, async (c) => {
      await c.query(
        `UPDATE task_steps SET status = 'cancelled', error = $2, updated_at = now(), finished_at = now()
          WHERE task_id = $1 AND status NOT IN ('completed','failed','cancelled','skipped')`,
        [task.id, reason],
      );
      await c.query(
        `UPDATE approvals SET status = 'invalidated', updated_at = now()
          WHERE task_id = $1 AND status IN ('pending','approved','executing')`,
        [task.id],
      );
    });
  }

  private async finalize(task: TaskRow): Promise<void> {
    const steps = await this.loadSteps(task.id);
    const allTerminal = steps.every((s) => TERMINAL_STEP.has(s.status));
    if (allTerminal) {
      const failed = steps.some((s) => s.status === 'failed');
      await this.finishTask(
        task,
        failed ? 'failed' : 'completed',
        failed ? 'Co najmniej jeden krok nie powiódł się' : null,
      );
      return;
    }
    const waiting = steps.some((s) => s.status === 'waiting_approval');
    await withSystemTx(this.deps.db, async (c) => {
      const r = await c.query(
        `UPDATE tasks SET status = $3, lease_owner = NULL, lease_expires_at = NULL, updated_at = now(),
                progress = $4
          WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
        [task.id, this.workerId, waiting ? 'waiting_approval' : 'failed', progressOf(steps)],
      );
      if (r.rowCount === 1) {
        await emitEvent(c, {
          householdId: task.household_id,
          ownerUserId: task.owner_user_id,
          visibility: task.visibility,
          taskId: task.id,
          type: 'task.status',
          payload: { status: waiting ? 'waiting_approval' : 'failed', progress: progressOf(steps) },
        });
      }
    });
  }

  private async finishTask(
    task: TaskRow,
    status: 'completed' | 'failed',
    error: string | null,
  ): Promise<void> {
    const steps = await this.loadSteps(task.id);
    await withSystemTx(this.deps.db, async (c) => {
      const r = await c.query(
        `UPDATE tasks SET status = $3, error = $4, lease_owner = NULL, lease_expires_at = NULL,
                finished_at = now(), updated_at = now(), progress = $5,
                result = $6
          WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
        [
          task.id,
          this.workerId,
          status,
          error,
          status === 'completed' ? 100 : progressOf(steps),
          JSON.stringify({ steps: steps.map((s) => ({ key: s.key, status: s.status })) }),
        ],
      );
      if (r.rowCount === 1) {
        await emitEvent(c, {
          householdId: task.household_id,
          ownerUserId: task.owner_user_id,
          visibility: task.visibility,
          taskId: task.id,
          type: 'task.status',
          payload: { status, error },
        });
      }
    });
  }
}

function progressOf(steps: StepRow[]): number {
  if (!steps.length) return 0;
  const done = steps.filter((s) => TERMINAL_STEP.has(s.status)).length;
  return Math.round((done / steps.length) * 100);
}
