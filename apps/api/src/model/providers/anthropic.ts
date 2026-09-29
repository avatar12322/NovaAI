import Anthropic from '@anthropic-ai/sdk';
import {
  fromProviderToolName,
  ProviderError,
  toProviderToolName,
  type ModelProvider,
  type ProviderRequest,
  type ProviderResponse,
  type WebSource,
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
    const tools: Anthropic.Messages.ToolUnion[] = req.tools.map((t) => ({
      name: toProviderToolName(t.name),
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));
    if (req.webSearch) tools.push(webSearchTool(req.model, req.webSearch.maxUses));
    const base = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      ...(tools.length ? { tools, tool_choice: { type: 'auto' as const } } : {}),
      ...(req.effort ? { output_config: { effort: req.effort } } : {}),
    };
    // Zdjęcia przed tekstem (zalecenie dokumentacji Claude dla obrazów).
    const messages: Anthropic.MessageParam[] = req.messages.map((m) => ({
      role: m.role,
      content: m.images?.length
        ? [
            ...m.images.map((i): Anthropic.ImageBlockParam => ({
              type: 'image',
              source: { type: 'base64', media_type: i.mediaType, data: i.data },
            })),
            { type: 'text' as const, text: m.content },
          ]
        : m.content,
    }));
    const parts: Anthropic.Message[] = [];
    try {
      // Wyszukiwanie może przerwać turę (pause_turn) — wznowienie: ta sama wiadomość asystenta odesłana bez zmian.
      for (let round = 0; round <= MAX_CONTINUATIONS; round++) {
        const params = { ...base, messages };
        let res: Anthropic.Message;
        if (req.onText) {
          // Strumieniowanie: fragmenty tekstu na żywo, a wynik (narzędzia, usage) z pełnej wiadomości.
          const stream = this.client.messages.stream(params, { signal: req.signal });
          const onText = req.onText;
          stream.on('text', (delta) => onText(delta));
          res = await stream.finalMessage();
        } else {
          res = await this.client.messages.create(params, { signal: req.signal });
        }
        parts.push(res);
        if (res.stop_reason !== 'pause_turn') break;
        messages.push({ role: 'assistant', content: res.content as Anthropic.ContentBlockParam[] });
      }
    } catch (err) {
      throw mapError(err);
    }

    const last = parts.at(-1)!;
    const usage = sumUsage(parts);
    const webSearches = parts.reduce(
      (n, p) => n + (p.usage?.server_tool_use?.web_search_requests ?? 0),
      0,
    );
    const searched = webSearches ? { webSearches } : {};
    if (last.stop_reason === 'refusal') {
      return { text: '', toolCalls: [], usage, stopReason: 'refusal', ...searched };
    }
    const blocks = parts.flatMap((p) => p.content);
    // Z cytowaniami tekst przychodzi w wielu blokach (także w środku zdania) — łączone bez separatora.
    const text = blocks
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    const toolCalls = blocks
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({
        name: fromProviderToolName(b.name),
        input: (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>,
      }));
    const webSources = citedSources(blocks);
    return {
      text,
      toolCalls,
      usage,
      stopReason: last.stop_reason ?? null,
      ...searched,
      ...(webSources.length ? { webSources } : {}),
    };
  }
}

/** Najwyżej tyle wznowień po pause_turn (ochrona przed pętlą). */
const MAX_CONTINUATIONS = 3;

/**
 * Narzędzie wyszukiwania (dokumentacja sprawdzona 2026-09-27): `web_search_20260209` z filtrowaniem wyników
 * (dynamic filtering) dla modeli Claude 4.6 i nowszych, `web_search_20250305` dla starszych. Wyniki
 * lokalizowane do Polski. 10 USD / 1000 wyszukań + tokeny wyników (cena w cenniku modelu).
 */
export function webSearchTool(model: string, maxUses: number): Anthropic.Messages.ToolUnion {
  const dynamic = /^claude-(opus|sonnet|fable|mythos)-(5|4-[6-9])/.test(model);
  return {
    type: dynamic ? 'web_search_20260209' : 'web_search_20250305',
    name: 'web_search',
    max_uses: maxUses,
    user_location: { type: 'approximate', country: 'PL', timezone: 'Europe/Warsaw' },
  } as Anthropic.Messages.ToolUnion;
}

/** Cytowane źródła z internetu (url, tytuł) — bez powtórzeń, najwyżej 8. */
function citedSources(blocks: Anthropic.ContentBlock[]): WebSource[] {
  const seen = new Map<string, WebSource>();
  for (const b of blocks) {
    if (b.type !== 'text' || !b.citations) continue;
    for (const c of b.citations) {
      if (c.type !== 'web_search_result_location' || !/^https?:\/\//i.test(c.url)) continue;
      if (!seen.has(c.url))
        seen.set(c.url, { url: c.url, title: (c.title ?? c.url).slice(0, 200) });
    }
  }
  return [...seen.values()].slice(0, 8);
}

function sumUsage(parts: Anthropic.Message[]): ProviderResponse['usage'] {
  const all = parts.map(usageOf);
  if (all.some((u) => u === null)) return null;
  return all.reduce((a, u) => ({
    inputTokens: a!.inputTokens + u!.inputTokens,
    outputTokens: a!.outputTokens + u!.outputTokens,
    cacheReadTokens: a!.cacheReadTokens + u!.cacheReadTokens,
    cacheWriteTokens: a!.cacheWriteTokens + u!.cacheWriteTokens,
  }));
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
