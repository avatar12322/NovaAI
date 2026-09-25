import type { ContextKind } from '@nova/permissions';
import { z } from 'zod';
import type { ToolSpec } from '../model/types';
import { writeAudit } from '../audit';
import { canonicalJson, hashParams } from '../lib/crypto';
import { redact } from '../lib/redact';
import {
  ToolDenied,
  type ToolContext,
  type ToolDef,
  type ToolPreview,
  type ToolResult,
} from './types';

export interface PlannedCall {
  tool: string;
  capability: string;
  params: Record<string, unknown>;
  requiresApproval: boolean;
  preview: ToolPreview;
  actionHash: string;
}

/** Skrót zamrożonej akcji — zgoda dotyczy dokładnie tej pary {tool, params}. */
export function actionHash(tool: string, params: Record<string, unknown>): string {
  return hashParams({ tool, params });
}

export interface ExecuteOptions {
  idempotencyKey: string;
  approvalId?: string | null;
}

/**
 * Broker narzędzi: jedyna droga od propozycji modelu do efektu. Sprawdza kontekst, parametry,
 * uprawnienia (przy planowaniu i ponownie przy wykonaniu), zgodę i idempotencję; audytuje wszystko.
 * Wynik narzędzia to dane — nigdy nie zmienia uprawnień.
 */
export class ToolBroker {
  private readonly tools = new Map<string, ToolDef>();

  register<P extends Record<string, unknown>>(def: ToolDef<P>): this {
    if (this.tools.has(def.name)) throw new Error(`Narzędzie ${def.name} już zarejestrowane`);
    this.tools.set(def.name, def as unknown as ToolDef);
    return this;
  }

  /** Lista narzędzi dostępnych w kontekście — filtrowana serwerowo, zanim zobaczy ją model. */
  available(
    context: ContextKind,
  ): Array<{ name: string; title: string; requiresApproval: string }> {
    return [...this.tools.values()]
      .filter((t) => t.contexts.includes(context))
      .map((t) => ({ name: t.name, title: t.title, requiresApproval: 'zależnie od parametrów' }));
  }

  /** Opisy narzędzi (JSON Schema z zod) dla modelu — tylko dla nazw już dozwolonych w kontekście. */
  describe(names: readonly string[]): ToolSpec[] {
    return names
      .map((n) => this.tools.get(n))
      .filter((t): t is ToolDef => !!t)
      .map((t) => ({
        name: t.name,
        description: `${t.title}. Propozycja — serwer może wymagać zgody użytkownika przed wykonaniem.`,
        inputSchema: z.toJSONSchema(t.params, { io: 'input' }) as Record<string, unknown>,
      }));
  }

  capabilitiesFor(context: ContextKind): string[] {
    return [...this.tools.values()].filter((t) => t.contexts.includes(context)).map((t) => t.name);
  }

  private get(ctx: ToolContext, name: string): ToolDef {
    const def = this.tools.get(name);
    if (!def) throw new ToolDenied('unknown_tool');
    if (!def.contexts.includes(ctx.context)) throw new ToolDenied('tool_not_in_context');
    return def;
  }

  private parse(def: ToolDef, raw: unknown): Record<string, unknown> {
    const r = def.params.safeParse(raw);
    if (!r.success) throw new ToolDenied('invalid_params');
    return r.data;
  }

  private async audit(
    ctx: ToolContext,
    tool: string,
    action: string,
    outcome: 'allow' | 'deny' | 'ok' | 'error',
    params: unknown,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await writeAudit(ctx.deps.db, {
      actorKind: 'agent',
      actorUserId: ctx.principal.userId,
      ownerUserId: ctx.principal.userId,
      householdId: ctx.householdId,
      source: 'broker',
      action,
      resourceType: 'task',
      resourceId: ctx.taskId,
      tool,
      outcome,
      correlationId: ctx.correlationId,
      params,
      details: { ...details, context: ctx.context },
    });
  }

  /** Planowanie wywołania zaproponowanego przez model. Nie wykonuje żadnego efektu. */
  async plan(ctx: ToolContext, call: { tool: string; params: unknown }): Promise<PlannedCall> {
    try {
      const def = this.get(ctx, call.tool);
      let params = this.parse(def, call.params);
      if (def.prepare) params = await def.prepare(ctx, params);
      params = this.parse(def, params);
      const decision = await def.authorize(ctx, params);
      if (!decision.allow) throw new ToolDenied(decision.reason);
      const preview = await def.preview(ctx, params);
      await this.audit(ctx, def.name, 'tool.plan', 'allow', params);
      return {
        tool: def.name,
        capability: def.capability,
        params,
        requiresApproval: def.requiresApproval(params, ctx),
        preview,
        actionHash: actionHash(def.name, params),
      };
    } catch (err) {
      if (err instanceof ToolDenied) {
        await this.audit(ctx, call.tool, 'tool.plan', 'deny', call.params ?? {}, {
          reason: err.reason,
        });
      }
      throw err;
    }
  }

  /**
   * Wykonanie. Autoryzacja jest powtarzana w chwili wykonania; dla narzędzi wymagających zgody
   * broker sam sprawdza w bazie, że zgoda jest w stanie `executing` dla dokładnie tych parametrów.
   */
  async execute(
    ctx: ToolContext,
    tool: string,
    rawParams: unknown,
    opts: ExecuteOptions,
  ): Promise<ToolResult> {
    const db = ctx.deps.db;
    let def: ToolDef;
    let params: Record<string, unknown>;
    try {
      def = this.get(ctx, tool);
      params = this.parse(def, rawParams);
      if (!ctx.principal.activeHouseholdIds.has(ctx.householdId))
        throw new ToolDenied('not_active_member');
      if (ctx.taskId) {
        const t = await db.owner.query<{ status: string; owner_user_id: string }>(
          'SELECT status, owner_user_id FROM tasks WHERE id = $1',
          [ctx.taskId],
        );
        if (t.rows[0]?.status !== 'running') throw new ToolDenied('task_not_running');
        if (t.rows[0].owner_user_id !== ctx.principal.userId)
          throw new ToolDenied('task_owner_mismatch');
      }
      if (def.requiresApproval(params, ctx)) {
        if (!opts.approvalId) throw new ToolDenied('approval_required');
        const a = await db.owner.query<{
          status: string;
          action_hash: string;
          owner_user_id: string;
          step_id: string;
        }>('SELECT status, action_hash, owner_user_id, step_id FROM approvals WHERE id = $1', [
          opts.approvalId,
        ]);
        const ap = a.rows[0];
        if (!ap || ap.status !== 'executing') throw new ToolDenied('approval_not_active');
        if (ap.owner_user_id !== ctx.principal.userId)
          throw new ToolDenied('approval_owner_mismatch');
        if (ctx.stepId && ap.step_id !== ctx.stepId) throw new ToolDenied('approval_step_mismatch');
        if (ap.action_hash !== actionHash(def.name, params))
          throw new ToolDenied('approval_params_changed');
      }
      const decision = await def.authorize(ctx, params);
      if (!decision.allow) throw new ToolDenied(decision.reason);
    } catch (err) {
      if (err instanceof ToolDenied) {
        await this.recordDenied(ctx, tool, rawParams, opts, err.reason);
      }
      throw err;
    }

    // Idempotencja: jeden rekord tool_calls na klucz. Sukces => zwracamy zapisany wynik.
    const ins = await db.owner.query<{ id: string }>(
      `INSERT INTO tool_calls (household_id, owner_user_id, task_id, step_id, approval_id, tool, capability,
         params_hash, params_redacted, idempotency_key, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'running')
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [
        ctx.householdId,
        ctx.principal.userId,
        ctx.taskId,
        ctx.stepId,
        opts.approvalId ?? null,
        def.name,
        def.capability,
        hashParams(params),
        JSON.stringify(redact(params)),
        opts.idempotencyKey,
      ],
    );
    let callId = ins.rows[0]?.id;
    if (!callId) {
      const prev = await db.owner.query<{
        id: string;
        status: string;
        result_summary: string | null;
      }>('SELECT id, status, result_summary FROM tool_calls WHERE idempotency_key = $1', [
        opts.idempotencyKey,
      ]);
      const p = prev.rows[0]!;
      if (p.status === 'succeeded') {
        await this.audit(ctx, def.name, 'tool.execute', 'ok', params, { idempotentReplay: true });
        return { summary: p.result_summary ?? '', output: { replay: true } };
      }
      // Poprzednia próba przerwana (np. restart) — narzędzia są idempotentne względem klucza.
      callId = p.id;
      await db.owner.query(`UPDATE tool_calls SET status = 'running' WHERE id = $1`, [callId]);
    }

    try {
      const result = await def.execute(ctx, params, opts.idempotencyKey);
      await db.owner.query(
        `UPDATE tool_calls SET status = 'succeeded', result_summary = $2, finished_at = now() WHERE id = $1`,
        [callId, result.summary.slice(0, 500)],
      );
      await this.audit(ctx, def.name, 'tool.execute', 'ok', params);
      return result;
    } catch (err) {
      await db.owner.query(
        `UPDATE tool_calls SET status = 'failed', result_summary = $2, finished_at = now() WHERE id = $1`,
        [callId, (err as Error).message.slice(0, 500)],
      );
      await this.audit(ctx, def.name, 'tool.execute', 'error', params, {
        error: (err as Error).message,
      });
      throw err;
    }
  }

  private async recordDenied(
    ctx: ToolContext,
    tool: string,
    rawParams: unknown,
    opts: ExecuteOptions,
    reason: string,
  ): Promise<void> {
    await ctx.deps.db.owner.query(
      `INSERT INTO tool_calls (household_id, owner_user_id, task_id, step_id, approval_id, tool, capability,
         params_hash, params_redacted, status, result_summary, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'denied',$10, now())`,
      [
        ctx.householdId,
        ctx.principal.userId,
        ctx.taskId,
        ctx.stepId,
        opts.approvalId ?? null,
        tool.slice(0, 100),
        this.tools.get(tool)?.capability ?? 'unknown',
        hashParams(canonicalJson(rawParams ?? {})),
        JSON.stringify(redact(rawParams ?? {})),
        reason,
      ],
    );
    await this.audit(ctx, tool, 'tool.execute', 'deny', rawParams ?? {}, { reason });
  }
}
