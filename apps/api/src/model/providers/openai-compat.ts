import {
  fromProviderToolName,
  ProviderError,
  toProviderToolName,
  type ModelProvider,
  type ProviderRequest,
  type ProviderResponse,
} from '../types';

export interface OpenAiCompatOptions {
  /** Np. http://127.0.0.1:8642/v1 (Hermes API server) — bez końcowego ukośnika. */
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  label?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: Array<{ type?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
}

/**
 * Adapter endpointu zgodnego z OpenAI Chat Completions (`POST {baseUrl}/chat/completions`,
 * `Authorization: Bearer`). Używany dla Hermes API server (profil = model ID) i lokalnych serwerów.
 * UWAGA: Hermes wykonuje własne narzędzia po swojej stronie — patrz docs/DECISIONS.md (D-017).
 */
export class OpenAiCompatProvider implements ModelProvider {
  readonly kind = 'openai_compatible';

  constructor(private readonly opts: OpenAiCompatOptions) {}

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const label = this.opts.label ?? 'openai_compatible';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 120_000);
    req.signal?.addEventListener('abort', () => ctrl.abort());
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          messages: [{ role: 'system', content: req.system }, ...req.messages],
          ...(req.tools.length
            ? {
                tools: req.tools.map((t) => ({
                  type: 'function',
                  function: {
                    name: toProviderToolName(t.name),
                    description: t.description,
                    parameters: t.inputSchema,
                  },
                })),
                tool_choice: 'auto',
              }
            : {}),
        }),
      });
    } catch {
      throw new ProviderError(`${label}: brak połączenia`, true);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // Treść odpowiedzi błędu nie jest przekazywana dalej (może zawierać echo żądania).
      throw new ProviderError(
        `${label}: HTTP ${res.status}`,
        res.status === 429 || res.status >= 500,
        res.status,
      );
    }
    let body: ChatCompletionResponse;
    try {
      body = (await res.json()) as ChatCompletionResponse;
    } catch {
      throw new ProviderError(`${label}: nieprawidłowa odpowiedź`, true);
    }
    const choice = body.choices?.[0];
    const toolCalls: ProviderResponse['toolCalls'] = [];
    for (const tc of choice?.message?.tool_calls ?? []) {
      if (!tc.function?.name) continue;
      let input: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(tc.function.arguments ?? '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
          input = parsed as Record<string, unknown>;
      } catch {
        continue; // Uszkodzone argumenty => propozycja odrzucona (broker i tak waliduje).
      }
      toolCalls.push({ name: fromProviderToolName(tc.function.name), input });
    }
    const u = body.usage;
    const usage =
      u && typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number'
        ? {
            inputTokens: u.prompt_tokens,
            outputTokens: u.completion_tokens,
            cacheReadTokens: u.cache_read_tokens ?? 0,
            cacheWriteTokens: u.cache_write_tokens ?? 0,
          }
        : null;
    return {
      text: (choice?.message?.content ?? '').trim(),
      toolCalls,
      usage,
      stopReason: choice?.finish_reason ?? null,
    };
  }
}
