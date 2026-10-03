import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnthropicProvider } from './providers/anthropic';
import { OpenAiCompatProvider, tokenParamFor } from './providers/openai-compat';
import { ProviderError, type ProviderRequest } from './types';

/**
 * Testy kontraktowe adapterów na lokalnym serwerze-mocku — bez sieci i bez płatnych wywołań.
 * Sprawdzają kształt żądania (nagłówki, ciało) i mapowanie odpowiedzi/błędów.
 */
interface Captured {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: any;
}
let server: Server;
let base: string;
let captured: Captured[] = [];
let respond: (c: Captured) => { status: number; body?: unknown; sse?: string } = () => ({
  status: 200,
  body: {},
});

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const c: Captured = {
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      };
      captured.push(c);
      const r = respond(c);
      if (r.sse !== undefined) {
        res.writeHead(r.status, { 'content-type': 'text/event-stream' });
        res.end(r.sse);
        return;
      }
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  captured = [];
});

const SECRET = 'sk-test-SECRET-should-never-leak';
const req = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model: 'model-from-config',
  system: 'SYSTEM',
  messages: [
    { role: 'user', content: 'cześć' },
    { role: 'assistant', content: 'hej' },
    { role: 'user', content: 'zapamiętaj to' },
  ],
  tools: [
    {
      name: 'memory.create',
      description: 'Zapisz',
      inputSchema: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
      },
    },
  ],
  maxTokens: 1234,
  ...over,
});

describe('AnthropicProvider (SDK) — kontrakt Messages API', () => {
  const provider = () =>
    new AnthropicProvider({ apiKey: SECRET, baseURL: base, maxRetries: 0, timeoutMs: 5000 });

  it('strumieniowanie: fragmenty tekstu na żywo, a narzędzia i usage z pełnej wiadomości', async () => {
    // Sekwencja zdarzeń strumienia Messages API (message_start → bloki → message_delta → message_stop).
    const ev = (type: string, data: Record<string, unknown>) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    respond = () => ({
      status: 200,
      sse:
        ev('message_start', {
          message: {
            id: 'msg_s',
            type: 'message',
            role: 'assistant',
            model: 'model-from-config',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 120, output_tokens: 1 },
          },
        }) +
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Zapisuję ' } }) +
        ev('content_block_delta', {
          index: 0,
          delta: { type: 'text_delta', text: 'to w pamięci.' },
        }) +
        ev('content_block_stop', { index: 0 }) +
        ev('content_block_start', {
          index: 1,
          content_block: { type: 'tool_use', id: 'tu_1', name: 'memory__create', input: {} },
        }) +
        ev('content_block_delta', {
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"content":"kawa"}' },
        }) +
        ev('content_block_stop', { index: 1 }) +
        ev('message_delta', {
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 42 },
        }) +
        ev('message_stop', {}),
    });
    const deltas: string[] = [];
    const r = await provider().complete({ ...req(), onText: (d) => deltas.push(d) });
    expect(captured[0]!.body.stream).toBe(true);
    expect(deltas).toEqual(['Zapisuję ', 'to w pamięci.']);
    expect(r.text).toBe('Zapisuję to w pamięci.');
    expect(r.toolCalls).toEqual([{ name: 'memory.create', input: { content: 'kawa' } }]);
    expect(r.usage).toMatchObject({ inputTokens: 120, outputTokens: 42 });
    expect(r.stopReason).toBe('tool_use');
  });

  it('wysyła poprawne żądanie i mapuje tekst, tool_use i usage', async () => {
    respond = () => ({
      status: 200,
      body: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'model-from-config',
        content: [
          { type: 'text', text: 'Zapisuję.' },
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'memory__create',
            input: { content: 'kawa bez cukru' },
          },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: {
          input_tokens: 321,
          output_tokens: 45,
          cache_read_input_tokens: 7,
          cache_creation_input_tokens: 0,
        },
      },
    });
    const r = await provider().complete(req({ effort: 'low' }));
    expect(captured).toHaveLength(1);
    const c = captured[0]!;
    expect(c.method).toBe('POST');
    expect(c.url).toBe('/v1/messages');
    expect(c.headers['x-api-key']).toBe(SECRET);
    expect(c.headers['anthropic-version']).toBeTruthy();
    expect(c.body).toMatchObject({
      model: 'model-from-config',
      max_tokens: 1234,
      // Pamięć podręczna: znacznik na końcu promptu systemowego (obejmuje też narzędzia)…
      system: [{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }],
      tool_choice: { type: 'auto' },
      output_config: { effort: 'low' },
    });
    expect(c.body.messages).toHaveLength(3);
    // …i na końcu historii (przedostatnia wiadomość); ostatnia — bieżące dane i pytanie — bez znacznika.
    const marks = (c.body.messages as Array<{ content: Array<Record<string, unknown>> }>).map((m) =>
      m.content.map((b) => b.cache_control ?? null),
    );
    expect(marks).toEqual([[null], [{ type: 'ephemeral' }], [null]]);
    expect(JSON.stringify(c.body).match(/cache_control/g)).toHaveLength(2);
    expect(c.body.tools[0]).toMatchObject({
      name: 'memory__create',
      input_schema: { type: 'object' },
    });
    expect(r).toEqual({
      text: 'Zapisuję.',
      toolCalls: [{ name: 'memory.create', input: { content: 'kawa bez cukru' } }],
      usage: { inputTokens: 321, outputTokens: 45, cacheReadTokens: 7, cacheWriteTokens: 0 },
      stopReason: 'tool_use',
    });
  });

  it('wyszukiwanie w internecie: wersja narzędzia wg modelu, wznowienie po pause_turn, źródła i liczba wyszukań', async () => {
    const msg = (content: unknown[], stop: string, searches: number) => ({
      id: 'msg_w',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        server_tool_use: { web_search_requests: searches },
      },
    });
    const search = [
      { type: 'text', text: 'Sprawdzam pogodę. ' },
      {
        type: 'server_tool_use',
        id: 'srvtoolu_1',
        name: 'web_search',
        input: { query: 'pogoda Kraków jutro' },
      },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: [
          {
            type: 'web_search_result',
            url: 'https://pogoda.example/krakow',
            title: 'Pogoda Kraków',
            encrypted_content: 'ENC',
            page_age: null,
          },
        ],
      },
    ];
    const cite = (url: string, title: string) => ({
      type: 'web_search_result_location',
      url,
      title,
      encrypted_index: 'IDX',
      cited_text: 'jutro 14°C',
    });
    const answer = [
      { type: 'text', text: 'Jutro w Krakowie ', citations: null },
      {
        type: 'text',
        text: 'będzie 14°C',
        citations: [cite('https://pogoda.example/krakow', 'Pogoda Kraków')],
      },
      {
        type: 'text',
        text: ' i deszcz.',
        citations: [
          cite('https://pogoda.example/krakow', 'Pogoda Kraków'),
          cite('javascript:alert(1)', 'zły'),
        ],
      },
    ];
    let n = 0;
    respond = () => ({
      status: 200,
      body: n++ === 0 ? msg(search, 'pause_turn', 1) : msg(answer, 'end_turn', 1),
    });
    const r = await provider().complete(
      req({ model: 'claude-sonnet-5', tools: [], webSearch: { maxUses: 3 } }),
    );
    expect(captured).toHaveLength(2);
    expect(captured[0]!.body.tools).toEqual([
      {
        type: 'web_search_20260209',
        name: 'web_search',
        max_uses: 3,
        user_location: { type: 'approximate', country: 'PL', timezone: 'Europe/Warsaw' },
      },
    ]);
    // Wznowienie: wstrzymana wiadomość asystenta odesłana bez zmian, bez dodatkowej wiadomości użytkownika.
    const resumed = captured[1]!.body.messages;
    expect(resumed).toHaveLength(4);
    expect(resumed[3]).toMatchObject({ role: 'assistant' });
    expect(resumed[3].content[2]).toMatchObject({
      type: 'web_search_tool_result',
      content: [{ encrypted_content: 'ENC' }],
    });
    expect(r).toEqual({
      text: 'Sprawdzam pogodę. Jutro w Krakowie będzie 14°C i deszcz.',
      toolCalls: [],
      usage: { inputTokens: 200, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: 'end_turn',
      webSearches: 2,
      webSources: [{ url: 'https://pogoda.example/krakow', title: 'Pogoda Kraków' }],
    });

    // Starszy model: podstawowa wersja narzędzia (bez filtrowania wyników).
    captured = [];
    respond = () => ({ status: 200, body: msg([{ type: 'text', text: 'ok' }], 'end_turn', 0) });
    await provider().complete(
      req({ model: 'claude-haiku-4-5-20251001', tools: [], webSearch: { maxUses: 3 } }),
    );
    expect(captured[0]!.body.tools[0].type).toBe('web_search_20250305');
  });

  it('bez narzędzi i effort nie wysyła tych pól', async () => {
    respond = () => ({
      status: 200,
      body: {
        id: 'm',
        type: 'message',
        role: 'assistant',
        model: 'x',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    await provider().complete(req({ tools: [] }));
    expect(captured[0]!.body).not.toHaveProperty('tools');
    expect(captured[0]!.body).not.toHaveProperty('output_config');
  });

  it('zdjęcie w wiadomości: blok image (base64) przed tekstem', async () => {
    respond = () => ({
      status: 200,
      body: {
        id: 'm',
        type: 'message',
        role: 'assistant',
        model: 'x',
        content: [{ type: 'text', text: 'Paragon: 45,20 zł' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    await provider().complete(
      req({
        tools: [],
        messages: [
          {
            role: 'user',
            content: 'ile na paragonie?',
            images: [{ mediaType: 'image/jpeg', data: 'QUJD' }],
          },
        ],
      }),
    );
    expect(captured[0]!.body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
          { type: 'text', text: 'ile na paragonie?' },
        ],
      },
    ]);
  });

  it('odmowa (stop_reason=refusal) jest zwracana jawnie', async () => {
    respond = () => ({
      status: 200,
      body: {
        id: 'm',
        type: 'message',
        role: 'assistant',
        model: 'x',
        content: [],
        stop_reason: 'refusal',
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    });
    const r = await provider().complete(req());
    expect(r.stopReason).toBe('refusal');
    expect(r.text).toBe('');
  });

  it('błędy: 401 nieponawialny, 500/429 ponawialne; brak sekretu w komunikacie', async () => {
    const err = (status: number) => ({
      status,
      body: { type: 'error', error: { type: 'x', message: `echo ${SECRET}` } },
    });
    respond = () => err(401);
    const e1 = await provider()
      .complete(req())
      .catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(ProviderError);
    expect((e1 as ProviderError).retryable).toBe(false);
    expect((e1 as Error).message).not.toContain(SECRET);
    respond = () => err(500);
    expect(
      (
        (await provider()
          .complete(req())
          .catch((e: unknown) => e)) as ProviderError
      ).retryable,
    ).toBe(true);
    respond = () => err(429);
    expect(
      (
        (await provider()
          .complete(req())
          .catch((e: unknown) => e)) as ProviderError
      ).retryable,
    ).toBe(true);
  });
});

describe('OpenAiCompatProvider (Hermes API server) — kontrakt Chat Completions', () => {
  const provider = () =>
    new OpenAiCompatProvider({ baseUrl: `${base}/v1`, apiKey: SECRET, timeoutMs: 5000 });

  it('wysyła Bearer, system jako pierwszą wiadomość, narzędzia jako functions; mapuje tool_calls i usage', async () => {
    respond = () => ({
      status: 200,
      body: {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: 'Proponuję zapis.',
              tool_calls: [
                {
                  type: 'function',
                  function: { name: 'memory__create', arguments: '{"content":"herbata"}' },
                },
                { type: 'function', function: { name: 'broken', arguments: '{nie-json' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, cache_read_tokens: 3 },
      },
    });
    const r = await provider().complete(req());
    const c = captured[0]!;
    expect(c.url).toBe('/v1/chat/completions');
    expect(c.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(c.body.messages[0]).toEqual({ role: 'system', content: 'SYSTEM' });
    expect(c.body.tools[0]).toMatchObject({
      type: 'function',
      function: { name: 'memory__create' },
    });
    expect(r.toolCalls).toEqual([{ name: 'memory.create', input: { content: 'herbata' } }]);
    expect(r.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
    });
  });

  it('zdjęcie: część image_url z adresem data:', async () => {
    respond = () => ({ status: 200, body: { choices: [{ message: { content: 'ok' } }] } });
    await provider().complete(
      req({
        tools: [],
        messages: [
          { role: 'user', content: 'co to?', images: [{ mediaType: 'image/png', data: 'UE5H' }] },
        ],
      }),
    );
    expect(captured[0]!.body.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'co to?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,UE5H' } },
      ],
    });
  });

  it('brak usage => null (koszt będzie estymacją)', async () => {
    respond = () => ({ status: 200, body: { choices: [{ message: { content: 'ok' } }] } });
    expect((await provider().complete(req())).usage).toBeNull();
  });

  it('HTTP 503 => ponawialny, 400 => nie; treść błędu nie jest przekazywana', async () => {
    respond = () => ({ status: 503, body: { error: SECRET } });
    const e = (await provider()
      .complete(req())
      .catch((x: unknown) => x)) as ProviderError;
    expect(e.retryable).toBe(true);
    expect(e.message).not.toContain(SECRET);
    respond = () => ({ status: 400, body: {} });
    expect(
      (
        (await provider()
          .complete(req())
          .catch((x: unknown) => x)) as ProviderError
      ).retryable,
    ).toBe(false);
  });

  it('limit wyjścia: max_tokens (Hermes, Gemini, lokalne); oficjalne API OpenAI — max_completion_tokens', async () => {
    respond = () => ({ status: 200, body: { choices: [{ message: { content: 'ok' } }] } });
    await provider().complete(req({ maxTokens: 321 }));
    expect(captured[0]!.body.max_tokens).toBe(321);
    expect(captured[0]!.body.max_completion_tokens).toBeUndefined();
    await new OpenAiCompatProvider({
      baseUrl: `${base}/v1`,
      apiKey: SECRET,
      tokenParam: 'max_completion_tokens',
    }).complete(req({ maxTokens: 321 }));
    expect(captured[1]!.body.max_completion_tokens).toBe(321);
    expect(captured[1]!.body.max_tokens).toBeUndefined();
    expect(tokenParamFor('https://api.openai.com/v1')).toBe('max_completion_tokens');
    expect(tokenParamFor('https://generativelanguage.googleapis.com/v1beta/openai')).toBe(
      'max_tokens',
    );
  });
});
