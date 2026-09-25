import type {
  AgentRuntime,
  AgentTurnInput,
  AgentTurnResult,
  AgentUserContext,
  ProposedToolCall,
} from './runtime';

/**
 * Deterministyczny runtime do testów i trybu demo. Bez sieci i bez kosztów.
 * Odpowiedź jawnie oznacza tryb demo. Prosta „retrieval” po słowach kluczowych pokazuje,
 * które pamięci były w kontekście — dzięki temu testy izolacji mogą to sprawdzić.
 */
export class FakeAgentRuntime implements AgentRuntime {
  readonly name = 'fake';

  async runTurn(
    input: AgentTurnInput,
    ctx: AgentUserContext,
    allowedCapabilities: readonly string[],
  ): Promise<AgentTurnResult> {
    const text = input.userMessage.trim();
    const lower = text.toLowerCase();
    const toolCalls: ProposedToolCall[] = [];
    const lines: string[] = [];

    const remember = /^(zapamiętaj|zapamietaj|remember)[:\s]+(.+)$/is.exec(text);
    if (remember?.[2] && allowedCapabilities.includes('memory.create')) {
      toolCalls.push({
        tool: 'memory.create',
        params: { content: remember[2].trim() },
        reason: 'prośba o zapamiętanie',
      });
      lines.push(`Zaproponowano zapisanie w pamięci: „${remember[2].trim()}”.`);
    }

    if (/co pamiętasz|co pamietasz|what do you remember/.test(lower)) {
      if (input.memories.length === 0)
        lines.push('Nie mam w tym kontekście żadnych zapisanych informacji.');
      else {
        lines.push(
          `W tym kontekście (${ctx.agentKind === 'household' ? 'wspólnym' : 'prywatnym'}) pamiętam:`,
        );
        for (const m of input.memories) lines.push(`- ${m.content}`);
      }
    } else {
      const words = new Set(lower.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4));
      const hits = input.memories.filter((m) =>
        m.content
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .some((w) => words.has(w)),
      );
      if (hits.length > 0) {
        lines.push('Powiązane informacje z pamięci:');
        for (const m of hits.slice(0, 5)) lines.push(`- ${m.content}`);
      }
    }

    if (lines.length === 0) {
      lines.push(`Otrzymałem: „${text.length > 200 ? `${text.slice(0, 200)}…` : text}”.`);
    }
    lines.push(
      `[tryb demo — ${ctx.agentName}; kontekst: ${input.history.length} wiad., ${input.memories.length} pamięci]`,
    );

    const inputTokens = Math.ceil(
      (text.length + input.history.reduce((n, m) => n + m.content.length, 0)) / 4,
    );
    const reply = lines.join('\n');
    return {
      reply,
      toolCalls,
      usage: {
        provider: 'fake',
        model: 'fake-deterministic',
        inputTokens,
        outputTokens: Math.ceil(reply.length / 4),
        estimated: true,
      },
      runtime: this.name,
      demo: true,
    };
  }
}
