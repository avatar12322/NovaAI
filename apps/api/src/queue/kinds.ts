import type { ContextKind } from '@nova/permissions';
import { buildTurnContext } from '../agent/context';
import { withUserTx } from '../db/pool';
import { emitEvent } from '../events';
import { insertMessage } from '../modules/conversations';
import { ToolDenied } from '../tools/types';
import type { StepSpec } from './tasks';
import type { RunnerDeps, TaskKindDef, TaskRow } from './runner';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function conversationContext(deps: RunnerDeps, task: TaskRow): Promise<ContextKind> {
  if (!task.conversation_id) throw new ToolDenied('no_conversation');
  const r = await deps.db.owner.query<{ kind: 'private' | 'household' }>(
    'SELECT a.kind FROM conversations c JOIN agents a ON a.id = c.agent_id WHERE c.id = $1',
    [task.conversation_id],
  );
  if (!r.rows[0]) throw new ToolDenied('conversation_gone');
  return r.rows[0].kind === 'household' ? 'household_agent' : 'private_agent';
}

/**
 * Tura czatu: kontekst budowany na nowo w chwili wykonania (aktualne uprawnienia),
 * odpowiedź zapisana w rozmowie, propozycje narzędzi => nowe kroki (przez broker).
 */
export const agentTurnKind: TaskKindDef = {
  context: conversationContext,
  steps: {
    reply: async (x) => {
      const messageId = String(x.task.input.messageId ?? '');
      const scope = x.context === 'household_agent' ? 'shared' : 'user';
      const userMessage = await withUserTx(
        x.deps.db,
        { userId: x.principal.userId, scope },
        async (c) => {
          const r = await c.query<{ content: string }>(
            'SELECT content FROM messages WHERE id = $1 AND conversation_id = $2',
            [messageId, x.task.conversation_id],
          );
          return r.rows[0]?.content ?? null;
        },
      );
      if (userMessage === null) throw new ToolDenied('message_not_visible');

      const ctx = await buildTurnContext(
        x.deps.db,
        x.principal,
        x.task.conversation_id!,
        userMessage,
        x.task.request_id ?? x.task.id,
      );
      await x.progress(30);
      const result = await x.deps.runtime.runTurn(
        ctx.input,
        ctx.userContext,
        x.deps.broker.capabilitiesFor(ctx.contextKind),
      );
      await x.progress(80);

      // Propozycje narzędzi => kroki; broker odrzuca niedozwolone (bez efektów).
      const newSteps: StepSpec[] = [];
      const denied: Array<{ tool: string; reason: string }> = [];
      for (const [i, call] of result.toolCalls.slice(0, 5).entries()) {
        try {
          const planned = await x.deps.broker.plan(x.toolContext, call);
          newSteps.push({
            key: `tool_${i + 1}`,
            title: planned.preview.summary,
            kind: 'tool',
            tool: planned.tool,
            params: planned.params,
            dependsOn: ['reply'],
            requiresApproval: planned.requiresApproval,
          });
        } catch (err) {
          if (!(err instanceof ToolDenied)) throw err;
          denied.push({ tool: String(call.tool).slice(0, 60), reason: err.reason });
        }
      }

      const message = await withUserTx(
        x.deps.db,
        { userId: x.principal.userId, scope: ctx.scope },
        async (c) => {
          const m = await insertMessage(c, {
            conversationId: x.task.conversation_id!,
            role: 'assistant',
            authorUserId: null,
            content: result.reply,
            meta: {
              runtime: result.runtime,
              demo: result.demo,
              agent: ctx.userContext.agentName,
              taskId: x.task.id,
              context: { messages: ctx.input.history.length, memories: ctx.input.memories.length },
              proposedTools: newSteps.map((s) => ({ tool: s.tool, approval: s.requiresApproval })),
              deniedTools: denied,
            },
            requestId: x.task.request_id,
          });
          return m;
        },
      );
      await withUserTx(x.deps.db, { userId: x.principal.userId, scope: 'user' }, (c) =>
        emitEvent(c, {
          householdId: x.task.household_id,
          ownerUserId: x.principal.userId,
          visibility: x.task.visibility,
          taskId: x.task.id,
          type: 'message.created',
          payload: {
            conversationId: x.task.conversation_id,
            messageId: message.id,
            role: 'assistant',
          },
        }),
      );
      await x.appendSteps(newSteps);
      return {
        messageId: message.id,
        proposedTools: newSteps.length,
        deniedTools: denied,
        usage: result.usage,
      };
    },
  },
};

/**
 * Jawnie oznaczone zadanie demonstracyjne: pokazuje postęp, kroki równoległe i zgodę na wysyłkę.
 * Nie wywołuje modelu (zero kosztu).
 */
export function demoWorkflowKind(stepMs: number): TaskKindDef {
  const work = (label: string) => async (x: Parameters<TaskKindDef['steps'][string]>[0]) => {
    for (let i = 1; i <= 4; i++) {
      await sleep(stepMs);
      if (x.isAborted()) throw new Error('Przerwano');
      await x.progress(i * 25);
    }
    return { note: `${label} — zakończone (demo)` };
  };
  return {
    context: async () => 'user',
    steps: {
      collect: work('Zebranie informacji'),
      draft: work('Przygotowanie szkicu'),
      summary: work('Podsumowanie'),
    },
  };
}

export function demoWorkflowSteps(message: string): StepSpec[] {
  return [
    { key: 'collect', title: 'Zbierz informacje (demo)', kind: 'note' },
    { key: 'draft', title: 'Przygotuj szkic (demo)', kind: 'note', dependsOn: ['collect'] },
    {
      key: 'notify',
      title: 'Wyślij wiadomość do domownika',
      kind: 'tool',
      tool: 'household.notify',
      params: { message },
      dependsOn: ['collect'],
      requiresApproval: true,
    },
    { key: 'summary', title: 'Podsumuj (demo)', kind: 'note', dependsOn: ['draft'] },
  ];
}
