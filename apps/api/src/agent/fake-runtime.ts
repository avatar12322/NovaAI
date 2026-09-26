import { plainText } from '../documents/text';
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
 *
 * Propozycje narzędzi są generowane NIEZALEŻNIE od `allowedCapabilities` — tak jak model, który
 * może „wymyślić” narzędzie. Granicą bezpieczeństwa jest broker, nie runtime.
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

    const remember = /(?:^|\n)\s*(zapamiętaj|zapamietaj|remember)[:\s]+(.+)$/im.exec(text);
    if (remember?.[2]) {
      toolCalls.push({
        tool: 'memory.create',
        params: { content: remember[2].trim() },
        reason: 'prośba o zapamiętanie',
      });
      lines.push(`Proponuję zapisać w pamięci: „${remember[2].trim()}”.`);
    }
    const notify =
      /(?:^|\n)\s*(napisz|powiadom|wyślij|wyslij)(?: do [^:\n]{1,40})?:\s*(.+)$/im.exec(text);
    if (notify?.[2]) {
      toolCalls.push({
        tool: 'household.notify',
        params: { message: notify[2].trim() },
        reason: 'prośba o wiadomość',
      });
      lines.push(`Proponuję wysłać wiadomość: „${notify[2].trim()}” (wymaga Twojej zgody).`);
    }
    const device = /(?:^|\n)\s*(pliki|przeczytaj|git status|git diff):\s*(\S.*)$/im.exec(text);
    if (device?.[1] && device[2]) {
      const kind = device[1].toLowerCase();
      const target = device[2].trim();
      const tool =
        kind === 'pliki'
          ? { tool: 'device.files.list', params: { path: target } }
          : kind === 'przeczytaj'
            ? { tool: 'device.files.read', params: { path: target } }
            : {
                tool: kind === 'git status' ? 'device.git.status' : 'device.git.diff',
                params: { repoPath: target },
              };
      toolCalls.push({ ...tool, reason: 'prośba o dane z urządzenia' });
      lines.push(`Sprawdzam na urządzeniu: ${target}.`);
    }
    const write = /(?:^|\n)\s*zapisz\s+(\S+):\s*([\s\S]+)$/im.exec(text);
    if (write?.[1] && write[2]) {
      toolCalls.push({
        tool: 'device.files.write',
        params: { path: write[1], content: write[2] },
        reason: 'prośba o zapis pliku',
      });
      lines.push(`Proponuję zapis pliku ${write[1]} (wymaga Twojej zgody z podglądem zmian).`);
    }
    const busy = /(?:^|\n)\s*zajętość:\s*(\S+)\s+(\S+)\s*$/im.exec(text);
    if (busy?.[1] && busy[2]) {
      toolCalls.push({
        tool: 'calendar.freebusy',
        params: { from: busy[1], to: busy[2] },
        reason: 'sprawdzenie zajętości',
      });
      lines.push('Sprawdzam zajętość w kalendarzach, które zostały udostępnione.');
    }
    // Opcjonalne słowo konta po poleceniu: „outlook” / „gmail” (bez niego — jedyne połączone konto).
    const acct = (w: string | undefined) =>
      w ? { account: /^outlook$/i.test(w) ? 'microsoft' : 'google' } : {};
    const outgoing =
      /(?:^|\n)\s*(wyślij mail|szkic maila)(?:\s+(outlook|gmail))?\s+do\s+(\S+?):\s*([^|\n]+)\|\s*([\s\S]+)$/im.exec(
        text,
      );
    if (outgoing?.[1] && outgoing[3] && outgoing[4] && outgoing[5]) {
      const draft = outgoing[1].toLowerCase().startsWith('szkic');
      toolCalls.push({
        tool: draft ? 'mail.draft' : 'mail.send',
        params: {
          to: outgoing[3],
          subject: outgoing[4].trim(),
          body: outgoing[5].trim(),
          ...acct(outgoing[2]),
        },
        reason: draft ? 'prośba o szkic e-maila' : 'prośba o wysłanie e-maila',
      });
      lines.push(
        draft
          ? `Proponuję zapisać szkic e-maila do ${outgoing[3]} (wymaga Twojej zgody; nic nie zostanie wysłane).`
          : `Proponuję wysłać e-mail do ${outgoing[3]} (wymaga Twojej zgody).`,
      );
    }
    const mailRead = /(?:^|\n)\s*przeczytaj maila(?:\s+(outlook|gmail))?:\s*(\S+)\s*$/im.exec(text);
    if (mailRead?.[2]) {
      toolCalls.push({
        tool: 'mail.read',
        params: { messageId: mailRead[2], ...acct(mailRead[1]) },
        reason: 'odczyt e-maila',
      });
      lines.push('Odczytuję wiadomość.');
    }
    const mailSearch = /(?:^|\n)\s*szukaj maili(?:\s+(outlook|gmail))?:\s*(.+)$/im.exec(text);
    if (mailSearch?.[2]) {
      toolCalls.push({
        tool: 'mail.search',
        params: { query: mailSearch[2].trim(), max: 10, ...acct(mailSearch[1]) },
        reason: 'wyszukiwanie e-maili',
      });
      lines.push('Szukam w poczcie.');
    }
    const events = /(?:^|\n)\s*wydarzenia(?:\s+(outlook|gmail))?:\s*(\S+)\s+(\S+)\s*$/im.exec(text);
    if (events?.[2] && events[3]) {
      toolCalls.push({
        tool: 'calendar.events',
        params: { from: events[2], to: events[3], max: 50, ...acct(events[1]) },
        reason: 'wydarzenia z kalendarza',
      });
      lines.push('Sprawdzam wydarzenia w Twoim kalendarzu.');
    }
    const remind =
      /(?:^|\n)\s*przypomnij (?:mi|nam)\s+(za\s+(\d{1,4})\s*(min|minut|minuty|godz|godzin|godziny|h)|(\d{4}-\d{2}-\d{2}T\S+))\s*:\s*(.+)$/im.exec(
        text,
      );
    if (remind?.[5]) {
      const now = Date.now();
      let due: string | null = remind[4] ?? null;
      if (!due && remind[2] && remind[3]) {
        const n = Number(remind[2]);
        const ms = remind[3].startsWith('m') ? n * 60_000 : n * 3_600_000;
        due = new Date(now + ms).toISOString();
      }
      if (due) {
        toolCalls.push({
          tool: 'reminder.create',
          params: { text: remind[5].trim(), dueAt: due },
          reason: 'prośba o przypomnienie',
        });
        lines.push(`Ustawiam przypomnienie: „${remind[5].trim()}”.`);
      }
    }
    // Celowo bez filtrowania po allowedCapabilities — granicę wyznacza broker.
    void allowedCapabilities;

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

    // Fragmenty dokumentów: demo cytuje najlepsze trafienia z odwołaniem [D1] (bez interpretacji treści —
    // polecenia zapisane w dokumencie nie są wykonywane, bo komendy czytamy wyłącznie z wiadomości).
    const docs = input.documents ?? [];
    if (docs.length && toolCalls.length === 0) {
      lines.push('Znalazłem w dokumentach:');
      for (const d of docs.slice(0, 2)) {
        const flat = plainText(d.content);
        lines.push(`„${flat.length > 240 ? `${flat.slice(0, 240)}…` : flat}” [${d.ref}]`);
      }
    }

    if (lines.length === 0) {
      lines.push(`Otrzymałem: „${text.length > 200 ? `${text.slice(0, 200)}…` : text}”.`);
    }
    lines.push(
      `[tryb demo — ${ctx.agentName}; kontekst: ${input.history.length} wiad., ${input.memories.length} pamięci, ${docs.length} fragm. dokumentów]`,
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
