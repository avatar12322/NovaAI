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
let respond: (c: Captured) => { status: number; body: unknown } = () => ({ status: 200, body: {} });

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
      system: 'SYSTEM',
      tool_choice: { type: 'auto' },
      output_config: { effort: 'low' },
    });
    expect(c.body.messages).toHaveLength(3);
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
