import type { ContextKind, Decision } from '@nova/permissions';
import type { z } from 'zod';
import type { AppDeps } from '../deps';
import type { Principal } from '../principal';

export interface ToolContext {
  deps: AppDeps;
  /** Świeżo załadowany właściciel zadania (członkostwa z chwili wykonania). */
  principal: Principal;
  context: ContextKind;
  householdId: string;
  /** Widoczność zadania/rozmowy, z której pochodzi wywołanie. */
  visibility: 'private' | 'shared';
  taskId: string | null;
  stepId: string | null;
  conversationId: string | null;
  correlationId: string;
}

export interface ToolPreview {
  summary: string;
  target: string;
  scope: string;
  diff?: string | null;
}

export interface ToolResult {
  summary: string;
  output: Record<string, unknown>;
}

export interface ToolDef<P extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  /** Akcja polityki sprawdzana przez broker (np. 'memory.create', 'household.notify'). */
  capability: string;
  title: string;
  /** Konteksty agentów, którym serwer w ogóle udostępnia narzędzie. */
  contexts: readonly ContextKind[];
  params: z.ZodType<P>;
  requiresApproval(p: P, ctx: ToolContext): boolean;
  /** Rozwiązanie i zamrożenie parametrów przed zgodą (np. wskazanie odbiorcy). */
  prepare?(ctx: ToolContext, p: P): Promise<P>;
  preview(ctx: ToolContext, p: P): Promise<ToolPreview>;
  /** Autoryzacja zasobowa — wywoływana przy planowaniu ORAZ ponownie tuż przed wykonaniem. */
  authorize(ctx: ToolContext, p: P): Promise<Decision>;
  /** Wykonanie musi być idempotentne względem klucza. */
  execute(ctx: ToolContext, p: P, idempotencyKey: string): Promise<ToolResult>;
}

export class ToolDenied extends Error {
  constructor(
    public readonly reason: string,
    message = `Odmowa wykonania narzędzia: ${reason}`,
  ) {
    super(message);
  }
}
