import type { ContextKind } from '@nova/permissions';
import { buildTurnContext } from '../agent/context';
import { withUserTx } from '../db/pool';
import { emitEvent } from '../events';
import { insertMessage } from '../modules/conversations';
import { writeAudit } from '../audit';
import { ToolDenied } from '../tools/types';
import type { StepSpec } from './tasks';
import type { MessageSource } from '@nova/contracts';
import type { AgentTurnResult, ContextDocument } from '../agent/runtime';
import type { RunnerDeps, StepExecution, TaskKindDef, TaskRow } from './runner';

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
 * Źródła odpowiedzi do meta wiadomości: identyfikatory i lokalizacja (bez treści fragmentu).
 * `cited` = odpowiedź zawiera odwołanie [Dn]; UI pokazuje cytowane źródła jako odnośniki do fragmentu.
 */
function messageSources(docs: ContextDocument[], reply: string): MessageSource[] {
  return docs.map((d) => ({
    ref: d.ref,
    documentId: d.documentId,
    title: d.title,
    ord: d.ord,
    page: d.page,
    lineStart: d.lineStart,
    lineEnd: d.lineEnd,
    heading: d.heading,
    cited: reply.includes(`[${d.ref}]`),
  }));
}

/** Wiadomość użytkownika, od której zaczęła się tura — odczyt pod RLS kontekstu zadania. */
async function loadUserMessage(x: StepExecution): Promise<string> {
  const messageId = String(x.task.input.messageId ?? '');
  const scope = x.context === 'household_agent' ? 'shared' : 'user';
  const content = await withUserTx(x.deps.db, { userId: x.principal.userId, scope }, async (c) => {
    const r = await c.query<{ content: string }>(
      'SELECT content FROM messages WHERE id = $1 AND conversation_id = $2',
      [messageId, x.task.conversation_id],
    );
    return r.rows[0]?.content ?? null;
  });
  if (content === null) throw new ToolDenied('message_not_visible');
  return content;
}

type TurnContext = Awaited<ReturnType<typeof buildTurnContext>>;

async function postAssistantMessage(
  x: StepExecution,
  ctx: TurnContext,
  result: AgentTurnResult,
  extraMeta: Record<string, unknown>,
): Promise<{ id: string }> {
  const message = await withUserTx(
    x.deps.db,
    { userId: x.principal.userId, scope: ctx.scope },
    (c) =>
      insertMessage(c, {
        conversationId: x.task.conversation_id!,
        role: 'assistant',
        authorUserId: null,
        content: result.reply,
        meta: {
          runtime: result.runtime,
          demo: result.demo,
          notice: result.notice ?? null,
          usage: result.usage,
          agent: ctx.userContext.agentName,
          taskId: x.task.id,
          context: { messages: ctx.input.history.length, memories: ctx.input.memories.length },
          ...extraMeta,
        },
        requestId: x.task.request_id,
      }),
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
  return message;
}

/**
 * Tura czatu: kontekst budowany na nowo w chwili wykonania (aktualne uprawnienia),
 * odpowiedź zapisana w rozmowie, propozycje narzędzi => nowe kroki (przez broker).
 */
export const agentTurnKind: TaskKindDef = {
  context: conversationContext,
  /**
   * Wynik narzędzia trafia do rozmowy jako wiadomość `tool` — tylko jeśli klasyfikacja wyniku pozwala:
   * wyniki prywatne (np. pliki z urządzenia) nigdy nie są zapisywane w rozmowie wspólnej.
   */
  async afterToolStep(x, output) {
    if (!x.task.conversation_id || !x.step.tool) return;
    const def = x.deps.broker.def(x.step.tool);
    if (def?.resultVisibility === 'private' && x.task.visibility !== 'private') {
      await writeAudit(x.deps.db, {
        actorKind: 'system',
        ownerUserId: x.principal.userId,
        householdId: x.task.household_id,
        source: 'queue',
        action: 'tool.result_withheld',
        resourceType: 'task',
        resourceId: x.task.id,
        tool: x.step.tool,
        outcome: 'deny',
        details: { reason: 'private_result_in_shared_conversation' },
      });
      return;
    }
    const scope = x.task.visibility === 'shared' ? 'shared' : 'user';
    await withUserTx(x.deps.db, { userId: x.principal.userId, scope }, async (c) => {
      const m = await insertMessage(c, {
        conversationId: x.task.conversation_id!,
        role: 'tool',
        authorUserId: null,
        content: formatToolResult(x.step.tool!, output),
        meta: { tool: x.step.tool, taskId: x.task.id, stepId: x.step.id },
        requestId: x.task.request_id,
      });
      await emitEvent(c, {
        householdId: x.task.household_id,
        ownerUserId: x.principal.userId,
        visibility: x.task.visibility,
        taskId: x.task.id,
        type: 'message.created',
        payload: { conversationId: x.task.conversation_id, messageId: m.id, role: 'tool' },
      });
    });
  },
  steps: {
    reply: async (x) => {
      const userMessage = await loadUserMessage(x);

      const ctx = await buildTurnContext(
        x.deps.db,
        x.principal,
        x.task.conversation_id!,
        userMessage,
        x.task.request_id ?? x.task.id,
      );
      await x.progress(30);
      // Narzędzia urządzeń tylko, gdy użytkownik ma aktywne urządzenie (mniej szumu i tokenów).
      let capabilities = x.deps.broker.capabilitiesFor(ctx.contextKind);
      if (capabilities.some((c) => c.startsWith('device.'))) {
        const hasDevice = await x.deps.db.owner.query(
          `SELECT 1 FROM devices WHERE owner_user_id = $1 AND status = 'active' LIMIT 1`,
          [x.principal.userId],
        );
        if (hasDevice.rowCount === 0)
          capabilities = capabilities.filter((c) => !c.startsWith('device.'));
      }
      // Narzędzia poczty tylko przy połączonym koncie z odpowiednim zakresem.
      if (capabilities.some((c) => c.startsWith('mail.'))) {
        const conns = x.deps.connections;
        const uid = x.principal.userId;
        const canRead = await conns.hasScope(
          uid,
          'google',
          'https://www.googleapis.com/auth/gmail.readonly',
        );
        const canSend = await conns.hasScope(
          uid,
          'google',
          'https://www.googleapis.com/auth/gmail.send',
        );
        capabilities = capabilities.filter(
          (c) => !c.startsWith('mail.') || (c === 'mail.send' ? canSend : canRead),
        );
      }
      const result = await x.deps.runtime.runTurn(
        { ...ctx.input, taskId: x.task.id },
        ctx.userContext,
        capabilities,
      );
      await x.progress(80);

      // Propozycje narzędzi => kroki; broker odrzuca niedozwolone (bez efektów).
      // Niezaufany kontekst (fragmenty dokumentów, wyniki narzędzi w historii) mógł podsunąć modelowi akcję:
      // wtedy każde narzędzie ze skutkami wymaga zgody człowieka, nawet jeśli zwykle jej nie wymaga.
      const untrusted =
        (ctx.input.documents?.length ?? 0) > 0 || ctx.input.history.some((m) => m.role === 'tool');
      const newSteps: StepSpec[] = [];
      const denied: Array<{ tool: string; reason: string }> = [];
      for (const [i, call] of result.toolCalls.slice(0, 5).entries()) {
        try {
          const planned = await x.deps.broker.plan(x.toolContext, call);
          const forced =
            untrusted && !planned.requiresApproval && !x.deps.broker.def(planned.tool)?.readOnly;
          newSteps.push({
            key: `tool_${i + 1}`,
            title: forced
              ? `${planned.preview.summary} (zgoda: w kontekście były treści z dokumentów lub narzędzi)`.slice(
                  0,
                  300,
                )
              : planned.preview.summary,
            kind: 'tool',
            tool: planned.tool,
            params: planned.params,
            dependsOn: ['reply'],
            requiresApproval: planned.requiresApproval || forced,
          });
        } catch (err) {
          if (!(err instanceof ToolDenied)) throw err;
          denied.push({ tool: String(call.tool).slice(0, 60), reason: err.reason });
        }
      }

      const message = await postAssistantMessage(x, ctx, result, {
        proposedTools: newSteps.map((s) => ({ tool: s.tool, approval: s.requiresApproval })),
        deniedTools: denied,
        sources: messageSources(ctx.input.documents ?? [], result.reply),
      });
      // Jedna tura uzupełniająca: po narzędziach bez zgody model odpowiada na podstawie ich wyników.
      // Narzędzia wymagające zgody mogą czekać godzinami — wtedy wynik trafia do rozmowy bez komentarza.
      if (!result.demo && newSteps.length && newSteps.every((s) => !s.requiresApproval)) {
        newSteps.push({
          key: 'followup',
          title: 'Odpowiedź na podstawie wyników',
          kind: 'model',
          dependsOn: newSteps.map((s) => s.key),
        });
      }
      await x.appendSteps(newSteps);
      return {
        messageId: message.id,
        proposedTools: newSteps.filter((s) => s.kind === 'tool').length,
        deniedTools: denied,
        usage: result.usage,
      };
    },
    followup: async (x) => {
      const userMessage = await loadUserMessage(x);
      const ctx = await buildTurnContext(
        x.deps.db,
        x.principal,
        x.task.conversation_id!,
        userMessage,
        x.task.request_id ?? x.task.id,
      );
      // Wyniki mogły zostać wstrzymane (prywatny wynik w rozmowie wspólnej) — wtedy bez wywołania modelu.
      if (ctx.input.history[ctx.input.history.length - 1]?.role !== 'tool') {
        return { skipped: 'no_visible_tool_results' };
      }
      await x.progress(30);
      const result = await x.deps.runtime.runTurn(
        { ...ctx.input, documents: [], taskId: x.task.id, followUp: true },
        ctx.userContext,
        [],
      );
      const message = await postAssistantMessage(x, ctx, result, { followUp: true });
      return { messageId: message.id, usage: result.usage };
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

const MAX_TOOL_MESSAGE = 6000;

/** Czytelna forma wyniku narzędzia do rozmowy (z limitem długości). */
export function formatToolResult(tool: string, out: Record<string, unknown>): string {
  const summary = typeof out.summary === 'string' ? out.summary : tool;
  let body = '';
  if (Array.isArray(out.entries)) {
    body = (out.entries as Array<{ name?: string; kind?: string; size?: number }>)
      .slice(0, 200)
      .map(
        (e) =>
          `${e.kind === 'dir' ? '[katalog]' : '[plik]   '} ${e.name ?? '?'}${e.kind === 'dir' ? '' : ` (${e.size ?? 0} B)`}`,
      )
      .join('\n');
  } else if (Array.isArray(out.members)) {
    body = (
      out.members as Array<{
        name: string;
        busy?: Array<{ start: string; end: string }>;
        unavailable?: string;
      }>
    )
      .map((m) =>
        m.unavailable
          ? `${m.name}: ${m.unavailable}`
          : `${m.name}: ${m.busy?.length ? m.busy.map((b) => `zajęte ${b.start} – ${b.end}`).join('; ') : 'wolne w tym zakresie'}`,
      )
      .join('\n');
  } else if (typeof out.reminderId === 'string') {
    body = '';
  } else if (Array.isArray(out.messages)) {
    body = (out.messages as Array<{ id: string; from: string; subject: string }>)
      .map((m) => `[${m.id}] ${m.from}: ${m.subject}`)
      .join('\n');
  } else if (typeof out.content === 'string') {
    body = `sha256: ${String(out.sha256 ?? '')}\n---\n${out.content}`;
  } else if (typeof out.output === 'string') {
    body = out.output || '(brak zmian)';
  } else if (typeof out.backupPath === 'string') {
    body = `Kopia zapasowa: ${out.backupPath}`;
  }
  const text = body ? `${summary}\n${body}` : summary;
  return text.length > MAX_TOOL_MESSAGE ? `${text.slice(0, MAX_TOOL_MESSAGE)}\n… (skrócono)` : text;
}
