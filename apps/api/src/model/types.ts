/** Kontrakt neutralny względem dostawcy. Żadne typy dostawców nie wyciekają poza `providers/`. */

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolSpec {
  /** Nazwa wewnętrzna (np. `memory.create`); adaptery mapują ją na format dostawcy. */
  name: string;
  description: string;
  /** JSON Schema parametrów (z zod). */
  inputSchema: Record<string, unknown>;
}

export interface ProviderRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  signal?: AbortSignal;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ProviderResponse {
  text: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  /** null = dostawca nie zwrócił wiarygodnych metadanych — koszt będzie estymacją. */
  usage: ProviderUsage | null;
  stopReason: string | null;
}

export interface ModelProvider {
  readonly kind: string;
  complete(req: ProviderRequest): Promise<ProviderResponse>;
}

/** Błąd dostawcy z informacją, czy warto spróbować ponownie / innego modelu. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
  }
}

/** Nazwy narzędzi muszą pasować do ^[a-zA-Z0-9_-]{1,64}$ u dostawców — kropka => `__`. */
export const toProviderToolName = (name: string) => name.replace(/\./g, '__');
export const fromProviderToolName = (name: string) => name.replace(/__/g, '.');
