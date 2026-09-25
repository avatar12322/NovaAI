import type { Message } from '@nova/contracts';
import type { AuthContext } from '../auth/session';
import { withUserTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { insertMessage } from '../modules/conversations';
import { buildTurnContext } from './context';

/**
 * Wykonuje turę agenta dla wiadomości użytkownika i zapisuje odpowiedź w rozmowie.
 * Zapis odpowiedzi następuje w tym samym zakresie (scope) co odczyt kontekstu.
 */
export async function runChatTurn(
  deps: AppDeps,
  auth: AuthContext,
  conversationId: string,
  userMessage: string,
  correlationId: string,
): Promise<Message> {
  const ctx = await buildTurnContext(deps.db, auth, conversationId, userMessage, correlationId);
  const result = await deps.runtime.runTurn(ctx.input, ctx.userContext, ctx.allowedCapabilities);
  return withUserTx(deps.db, { userId: auth.userId, scope: ctx.scope }, (c) =>
    insertMessage(c, {
      conversationId,
      role: 'assistant',
      authorUserId: null,
      content: result.reply,
      meta: {
        runtime: result.runtime,
        demo: result.demo,
        agent: ctx.userContext.agentName,
        context: { messages: ctx.input.history.length, memories: ctx.input.memories.length },
        usage: result.usage,
      },
      requestId: correlationId,
    }),
  );
}
