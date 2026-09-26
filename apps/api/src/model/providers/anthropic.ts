import Anthropic from '@anthropic-ai/sdk';
import {
  fromProviderToolName,
  ProviderError,
  toProviderToolName,
  type ModelProvider,
  type ProviderRequest,
  type ProviderResponse,
} from '../types';

interface AnthropicProviderOptions {
  apiKey: string;
  /** Tylko dla testów kontraktowych (lokalny serwer-mock). Domyślnie oficjalny endpoint SDK. */
  baseURL?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

/**
 * Adapter Claude (Messages API) przez oficjalny SDK `@anthropic-ai/sdk`.
 * Klucz jest przekazywany wyłącznie po stronie serwera i nigdy nie jest logowany.
 */
export class AnthropicProvider implements ModelProvider {
  readonly kind = 'anthropic';
  private readonly client: Anthropic;

  constructor(opts: AnthropicProviderOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      timeout: opts.timeoutMs ?? 120_000,
      maxRetries: opts.maxRetries ?? 2,
    });
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create(
        {
          model: req.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
          ...(req.tools.length
            ? {
                tools: req.tools.map((t) => ({
                  name: toProviderToolName(t.name),
                  description: t.description,
                  input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
                })),
                tool_choice: { type: 'auto' as const },
              }
            : {}),
          ...(req.effort ? { output_config: { effort: req.effort } } : {}),
        },
        { signal: req.signal },
      );
    } catch (err) {
      throw mapError(err);
    }

    if (res.stop_reason === 'refusal') {
      return { text: '', toolCalls: [], usage: usageOf(res), stopReason: 'refusal' };
    }
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const toolCalls = res.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({
        name: fromProviderToolName(b.name),
        input: (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>,
      }));
    return { text, toolCalls, usage: usageOf(res), stopReason: res.stop_reason ?? null };
  }
}

function usageOf(res: Anthropic.Message): ProviderResponse['usage'] {
  const u = res.usage;
  if (!u || typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') return null;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

function mapError(err: unknown): ProviderError {
  // Typowane wyjątki SDK — od najbardziej szczegółowych. Komunikaty bez treści żądania.
  if (err instanceof Anthropic.AuthenticationError)
    return new ProviderError('anthropic: błędny klucz API', false, 401);
  if (err instanceof Anthropic.PermissionDeniedError)
    return new ProviderError('anthropic: brak uprawnień', false, 403);
  if (err instanceof Anthropic.NotFoundError)
    return new ProviderError('anthropic: nieznany model', false, 404);
  if (err instanceof Anthropic.BadRequestError)
    return new ProviderError('anthropic: błędne żądanie', false, 400);
  if (err instanceof Anthropic.RateLimitError)
    return new ProviderError('anthropic: limit zapytań', true, 429);
  if (err instanceof Anthropic.InternalServerError)
    return new ProviderError('anthropic: błąd serwera', true, 500);
  if (err instanceof Anthropic.APIConnectionError)
    return new ProviderError('anthropic: brak połączenia', true);
  if (err instanceof Anthropic.APIError) {
    return new ProviderError(
      `anthropic: błąd ${err.status ?? ''}`.trim(),
      (err.status ?? 500) >= 500,
      err.status,
    );
  }
  return new ProviderError('anthropic: nieoczekiwany błąd', true);
}
