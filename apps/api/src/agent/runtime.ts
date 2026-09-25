/**
 * Kontrakt silnika agenta. Dostawca (Fake, Hermes, bezpośredni model) jest ukryty za interfejsem.
 * Runtime NIE ma dostępu do bazy — dostaje wyłącznie kontekst zbudowany i przefiltrowany przez serwer.
 */

export type AgentKind = 'private' | 'household';

export interface ContextMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  authorName?: string | null;
}

export interface ContextMemory {
  id: string;
  kind: 'profile' | 'episodic' | 'knowledge';
  visibility: 'private' | 'shared';
  content: string;
}

export interface AgentTurnInput {
  conversationId: string;
  /** Zadanie kolejki, w ramach którego działa tura (do rozliczenia kosztów). */
  taskId?: string | null;
  userMessage: string;
  history: ContextMessage[];
  memories: ContextMemory[];
}

export interface AgentUserContext {
  userId: string;
  displayName: string;
  householdId: string;
  agentKind: AgentKind;
  agentName: string;
  runtimeProfile: string;
}

/** Propozycja wywołania narzędzia — model tylko proponuje; broker decyduje i autoryzuje. */
export interface ProposedToolCall {
  tool: string;
  params: Record<string, unknown>;
  reason?: string;
}

export interface TurnUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** true, gdy dostawca nie zwrócił wiarygodnych metadanych i liczby są estymacją. */
  estimated: boolean;
  /** Koszt w walucie budżetu (0 dla demo/modeli bezpłatnych). */
  cost?: number;
  currency?: string;
}

export interface AgentTurnResult {
  reply: string;
  toolCalls: ProposedToolCall[];
  usage: TurnUsage | null;
  runtime: string;
  demo: boolean;
  /** Powód odpowiedzi zastępczej (bez wywołania modelu lub po odmowie). */
  notice?: 'budget_blocked' | 'model_unavailable' | 'provider_error' | 'refusal';
}

export interface AgentRuntime {
  readonly name: string;
  runTurn(
    input: AgentTurnInput,
    userContext: AgentUserContext,
    allowedCapabilities: readonly string[],
  ): Promise<AgentTurnResult>;
}
