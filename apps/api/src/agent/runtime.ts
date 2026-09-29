import type { TextStream } from '../live';

/**
 * Kontrakt silnika agenta. Dostawca (Fake, Hermes, bezpośredni model) jest ukryty za interfejsem.
 * Runtime NIE ma dostępu do bazy — dostaje wyłącznie kontekst zbudowany i przefiltrowany przez serwer.
 */

export type AgentKind = 'private' | 'household';

export interface ContextMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  authorName?: string | null;
  /**
   * Wynik narzędzia z treścią pobieraną na żywo (niezapisywaną, np. Slack): narzędzie, parametry i zadanie.
   * Nie jest wysyłane do modelu — służy do dołączenia treści w turze uzupełniającej.
   */
  live?: { tool: string; params: Record<string, unknown>; taskId: string | null };
  /** Zdjęcia dołączone do wiadomości użytkownika (identyfikatory; treść tylko w turze wysłania). */
  imageIds?: string[];
}

/** Zdjęcie z bieżącej wiadomości użytkownika (base64) — dla modeli z obsługą obrazów. */
export interface TurnImage {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  data: string;
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

/** Dokument dostępny w tym kontekście (bez treści) — model może go odczytać narzędziem `documents.read`. */
export interface ContextCatalogEntry {
  id: string;
  title: string;
  filename: string;
  pages: number | null;
  parts: number;
  visibility: 'private' | 'shared';
}

export interface AgentTurnInput {
  conversationId: string;
  /** Zadanie kolejki, w ramach którego działa tura (do rozliczenia kosztów). */
  taskId?: string | null;
  userMessage: string;
  /** Zdjęcia dołączone do bieżącej wiadomości (tylko w tej turze; w historii — znacznik „[zdjęcie]”). */
  userImages?: TurnImage[];
  history: ContextMessage[];
  memories: ContextMemory[];
  /** Fragmenty dokumentów pasujące do wiadomości (tylko z dokumentów dostępnych w tym kontekście). */
  documents?: ContextDocument[];
  /** Lista dokumentów dostępnych w tym kontekście (tytuły, bez treści). */
  catalog?: ContextCatalogEntry[];
  /** Tekst odpowiedzi na żywo (runtime ze strumieniowaniem); ostateczna odpowiedź i tak w wyniku tury. */
  stream?: TextStream;
  /**
   * Tura uzupełniająca po wykonaniu narzędzi: wiadomość użytkownika i wyniki są już w historii,
   * model formułuje odpowiedź na ich podstawie i nie dostaje narzędzi (jedna runda, bez pętli).
   */
  followUp?: boolean;
  /** Funkcje kont możliwe do włączenia, a teraz wyłączone (brak połączenia albo uprawnienia) — po polsku. */
  disabledFeatures?: string[];
  /** Wspólna lista zakupów domu — pozycje do kupienia (dane od domowników). */
  shopping?: string[];
  /** Pytanie ze Skrótu Siri: odpowiedź zostanie przeczytana na głos. */
  spoken?: boolean;
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
  /** Źródła z internetu cytowane w odpowiedzi (wyszukiwanie po stronie dostawcy) — pokazywane pod odpowiedzią. */
  webSources?: Array<{ url: string; title: string }>;
}

export interface AgentRuntime {
  readonly name: string;
  /**
   * Runtime faktycznie używany dla domu (np. demo albo model — zależnie od dostawców dodanych w aplikacji).
   * Brak metody => zawsze ten sam runtime.
   */
  resolveFor?(householdId: string | null): Promise<AgentRuntime>;
  runTurn(
    input: AgentTurnInput,
    userContext: AgentUserContext,
    allowedCapabilities: readonly string[],
  ): Promise<AgentTurnResult>;
}

/** Tryb asystenta dla domu: 'demo' (runtime deterministyczny) albo 'configured' (prawdziwy model). */
export async function runtimeFor(
  runtime: AgentRuntime,
  householdId: string | null,
): Promise<{ name: string; mode: 'demo' | 'configured' }> {
  const r = runtime.resolveFor ? await runtime.resolveFor(householdId) : runtime;
  return { name: r.name, mode: r.name === 'fake' ? 'demo' : 'configured' };
}
