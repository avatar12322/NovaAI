import { decide, scopeFor, type ContextKind } from '@nova/permissions';
import { writeAudit } from '../audit';
import type { Principal } from '../principal';
import { withUserTx, type Db } from '../db/pool';
import { notFound } from '../lib/errors';
import type { AgentTurnInput, AgentUserContext, ContextMemory, ContextMessage } from './runtime';

export const HISTORY_LIMIT = 20;
export const MEMORY_LIMIT = 50;

/** Zdolności, które serwer udostępnia agentowi w danym kontekście (model ich nie rozszerza). */
export function capabilitiesFor(kind: ContextKind): string[] {
  if (kind === 'household_agent') return ['memory.create'];
  if (kind === 'private_agent') return ['memory.create', 'reminder.create'];
  return [];
}

export interface BuiltContext {
  contextKind: ContextKind;
  scope: 'user' | 'shared';
  input: AgentTurnInput;
  userContext: AgentUserContext;
  allowedCapabilities: string[];
}

/**
 * Buduje kontekst tury agenta. Filtr uprawnień działa PRZED pobraniem danych:
 * zapytania idą przez RLS z zakresem kontekstu (NovaAI => tylko shared), a każdy rekord
 * jest dodatkowo sprawdzany polityką aplikacji. Dane spoza zakresu nigdy nie trafiają do modelu.
 */
export async function buildTurnContext(
  db: Db,
  auth: Principal,
  conversationId: string,
  userMessage: string,
  correlationId: string,
): Promise<BuiltContext> {
  const agentRow = await db.owner.query<{
    kind: 'private' | 'household';
    name: string;
    runtime_profile: string;
    household_id: string;
  }>(
    `SELECT a.kind, a.name, a.runtime_profile, a.household_id
       FROM conversations c JOIN agents a ON a.id = c.agent_id WHERE c.id = $1`,
    [conversationId],
  );
  const agent = agentRow.rows[0];
  if (!agent) throw notFound('Conversation');
  const contextKind: ContextKind = agent.kind === 'household' ? 'household_agent' : 'private_agent';
  const scope = scopeFor(contextKind);
  const actor = {
    userId: auth.userId,
    activeHouseholdIds: auth.activeHouseholdIds,
    context: contextKind,
  };

  const { history, memories, dropped } = await withUserTx(
    db,
    { userId: auth.userId, scope },
    async (c) => {
      const conv = await c.query<{
        owner_user_id: string;
        household_id: string;
        visibility: 'private' | 'shared';
      }>('SELECT owner_user_id, household_id, visibility FROM conversations WHERE id = $1', [
        conversationId,
      ]);
      const cm = conv.rows[0];
      if (
        !cm ||
        !decide(actor, 'conversation.read', {
          type: 'conversation',
          ownerUserId: cm.owner_user_id,
          householdId: cm.household_id,
          visibility: cm.visibility,
        }).allow
      ) {
        throw notFound('Conversation');
      }
      const msgs = await c.query<{
        role: ContextMessage['role'];
        content: string;
        author_name: string | null;
      }>(
        `SELECT m.role, m.content, u.display_name AS author_name
         FROM messages m LEFT JOIN users u ON u.id = m.author_user_id
        WHERE m.conversation_id = $1 ORDER BY m.created_at DESC, m.id DESC LIMIT $2`,
        [conversationId, HISTORY_LIMIT],
      );
      const mem = await c.query<{
        id: string;
        kind: ContextMemory['kind'];
        visibility: 'private' | 'shared';
        content: string;
        owner_user_id: string;
        household_id: string;
        active_grant: boolean;
      }>(
        `SELECT m.id, m.kind, m.visibility, m.content, m.owner_user_id, m.household_id,
              nova_memory_has_active_grant(m.id) AS active_grant
         FROM memories m
        WHERE m.household_id = $1 AND ($2 = 'user' OR m.visibility = 'shared')
        ORDER BY m.updated_at DESC, m.id DESC LIMIT $3`,
        [agent.household_id, scope, MEMORY_LIMIT],
      );
      let droppedCount = 0;
      const allowed: ContextMemory[] = [];
      for (const r of mem.rows) {
        const d = decide(actor, 'memory.read', {
          type: 'memory',
          ownerUserId: r.owner_user_id,
          householdId: r.household_id,
          visibility: r.visibility,
          activeShareGrant: r.active_grant,
        });
        if (d.allow)
          allowed.push({ id: r.id, kind: r.kind, visibility: r.visibility, content: r.content });
        else droppedCount++;
      }
      return {
        history: msgs.rows
          .reverse()
          .map((m) => ({ role: m.role, content: m.content, authorName: m.author_name })),
        memories: allowed,
        dropped: droppedCount,
      };
    },
  );

  if (dropped > 0) {
    // RLS i polityka aplikacji nie powinny się różnić — rozbieżność to sygnał błędu konfiguracji.
    await writeAudit(db, {
      actorKind: 'agent',
      actorUserId: auth.userId,
      ownerUserId: auth.userId,
      householdId: agent.household_id,
      source: 'api',
      action: 'agent.context.policy_mismatch',
      resourceType: 'conversation',
      resourceId: conversationId,
      outcome: 'deny',
      correlationId,
      details: { dropped, contextKind },
    });
  }

  // Ostatnia wiadomość użytkownika jest już w historii; runtime dostaje ją osobno.
  const trimmedHistory =
    history.length > 0 &&
    history[history.length - 1]?.role === 'user' &&
    history[history.length - 1]?.content === userMessage
      ? history.slice(0, -1)
      : history;

  return {
    contextKind,
    scope,
    input: { conversationId, userMessage, history: trimmedHistory, memories },
    userContext: {
      userId: auth.userId,
      displayName: auth.displayName,
      householdId: agent.household_id,
      agentKind: agent.kind,
      agentName: agent.name,
      runtimeProfile: agent.runtime_profile,
    },
    allowedCapabilities: capabilitiesFor(contextKind),
  };
}
