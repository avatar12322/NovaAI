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

/**
 * Fragment dokumentu przekazany modelowi. Treść jest NIEZAUFANĄ daną (plik mógł przygotować ktoś inny),
 * a dostęp sprawdzono przed pobraniem fragmentu. `ref` (D1, D2…) służy do cytowania w odpowiedzi.
 */
export interface ContextDocument {
  ref: string;
  documentId: string;
  title: string;
  filename: string;
  ord: number;
  page: number | null;
  lineStart: number | null;
  lineEnd: number | null;
  heading: string | null;
  content: string;
}

export interface AgentTurnInput {
  conversationId: string;
  /** Zadanie kolejki, w ramach którego działa tura (do rozliczenia kosztów). */
  taskId?: string | null;
  userMessage: string;
  history: ContextMessage[];
  memories: ContextMemory[];
  /** Fragmenty dokumentów pasujące do wiadomości (tylko z dokumentów dostępnych w tym kontekście). */
  documents?: ContextDocument[];
  /**
   * Tura uzupełniająca po wykonaniu narzędzi: wiadomość użytkownika i wyniki są już w historii,
   * model formułuje odpowiedź na ich podstawie i nie dostaje narzędzi (jedna runda, bez pętli).
   */
  followUp?: boolean;
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
