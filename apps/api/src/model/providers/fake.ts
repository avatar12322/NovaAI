import type { ModelProvider, ProviderRequest, ProviderResponse } from '../types';

/**
 * Deterministyczny dostawca do testów gateway/budżetu (bez sieci). Może symulować zużycie,
 * brak metadanych, błędy i propozycje narzędzi.
 */
export class FakeProvider implements ModelProvider {
  readonly kind = 'fake';
  calls: ProviderRequest[] = [];

  constructor(
    private readonly behavior: {
      usage?: ProviderResponse['usage'] | 'none';
      fail?: 'retryable' | 'fatal';
      toolCalls?: ProviderResponse['toolCalls'];
      text?: (req: ProviderRequest) => string;
    } = {},
  ) {}

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(req);
    if (this.behavior.fail) {
      const { ProviderError } = await import('../types');
      throw new ProviderError('fake: awaria', this.behavior.fail === 'retryable', 503);
    }
    const text = this.behavior.text
      ? this.behavior.text(req)
      : `fake(${req.model}): ${req.messages[req.messages.length - 1]?.content ?? ''}`;
    const usage =
      this.behavior.usage === 'none'
        ? null
        : (this.behavior.usage ?? {
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          });
    // Strumieniowanie jak u dostawcy: tekst w kawałkach, zanim wróci wynik.
    if (req.onText) for (let i = 0; i < text.length; i += 12) req.onText(text.slice(i, i + 12));
    // Jak prawdziwy model: bez udostępnionych narzędzi nie ma wywołań narzędzi.
    const toolCalls = req.tools.length ? (this.behavior.toolCalls ?? []) : [];
    return { text, toolCalls, usage, stopReason: 'end_turn' };
  }
}
