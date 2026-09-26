import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { canSee, liveTextStream, LiveHub, type LiveEvent } from './live';
import { ModelsConfigSchema } from './model/config';
import { FakeProvider } from './model/providers/fake';
import { createTestApp, login, type Client, type TestApp } from './test/helpers';

/** Odpowiedź na żywo (strumieniowanie): łączenie fragmentów, ponowna próba, odbiorcy jak dla rozmowy. */
describe('strumień tekstu', () => {
  it('łączy fragmenty co ~50 ms, podaje przesunięcia, a nowa próba zaczyna od zera', () => {
    vi.useFakeTimers();
    try {
      const hub = new LiveHub();
      const got: LiveEvent[] = [];
      hub.subscribe((e) => got.push(e));
      const target = { householdId: 'h', ownerUserId: 'u', visibility: 'private' as const };
      const s = liveTextStream(hub, target, { conversationId: 'c', taskId: 't', step: 'reply' });
      s.reset();
      s.push('Dzień ');
      s.push('dobry');
      expect(got).toHaveLength(0);
      vi.advanceTimersByTime(60);
      s.push(', Alfo.');
      s.flush();
      expect(got.map((e) => [e.payload.attempt, e.payload.offset, e.payload.delta])).toEqual([
        [0, 0, 'Dzień dobry'],
        [0, 11, ', Alfo.'],
      ]);
      // Błąd modelu i kolejny model z trasy: tekst od nowa (kolejna próba).
      s.reset();
      s.push('Inny model.');
      s.flush();
      expect(got.at(-1)!.payload).toMatchObject({ attempt: 1, offset: 0, delta: 'Inny model.' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('odbiorcy: prywatna — tylko właściciel, wspólna — aktywni członkowie domu', () => {
    const viewer = (userId: string, hh: string[]) => ({
      userId,
      activeHouseholdIds: new Set(hh),
    });
    const priv = { householdId: 'h', ownerUserId: 'a', visibility: 'private' as const };
    const shared = { ...priv, visibility: 'shared' as const };
    expect(canSee(priv, viewer('a', ['h']))).toBe(true);
    expect(canSee(priv, viewer('b', ['h']))).toBe(false);
    expect(canSee(shared, viewer('b', ['h']))).toBe(true);
    expect(canSee(shared, viewer('c', ['inny']))).toBe(false);
    expect(canSee(priv, viewer('a', []))).toBe(false); // członkostwo odebrane
  });
});

describe('SSE: tekst odpowiedzi na żywo', () => {
  const REPLY = 'To jest odpowiedź pisana na żywo, fragment po fragmencie.';
  const provider = new FakeProvider({ text: () => REPLY });
  let t: TestApp;
  let base: string;
  let alfa: Client;
  let beta: Client;

  beforeAll(async () => {
    t = await createTestApp(
      {},
      {
        modelsConfig: ModelsConfigSchema.parse({
          currency: 'PLN',
          providers: { llm: { kind: 'fake' } },
          models: {
            main: {
              provider: 'llm',
              model: 'test-model',
              maxTokens: 500,
              pricing: { currency: 'PLN', inputPerMTok: 1, outputPerMTok: 1 },
            },
          },
          routes: { 'chat.simple': ['main'], 'chat.complex': ['main'] },
        }),
        providerOverrides: { llm: provider },
      },
    );
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
    alfa = await login(t.app, 'alfa');
    beta = await login(t.app, 'beta');
  });
  afterAll(async () => t.close());

  /** Minimalny czytnik SSE: nazwa zdarzenia + dane. */
  async function open(cookie: string) {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/events/stream`, {
      headers: { cookie },
      signal: ctrl.signal,
    });
    const got: Array<{ event: string; data: any }> = [];
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const event = /^event: (.+)$/m.exec(chunk)?.[1];
            const data = /^data: (.+)$/m.exec(chunk)?.[1];
            if (event && data) got.push({ event, data: JSON.parse(data) });
          }
        }
      } catch {
        /* zamknięte */
      }
    })();
    // Połączenie gotowe, zanim zacznie się tura (komentarz „connected”).
    await new Promise((r) => setTimeout(r, 150));
    return { got, close: () => ctrl.abort() };
  }

  async function turn(c: Client, space: 'private' | 'shared') {
    const conv = (await c.post('/api/conversations', { space })).body;
    await c.post(`/api/conversations/${conv.id}/messages`, { content: 'hej' });
    await t.drain();
    await new Promise((r) => setTimeout(r, 150));
    return conv.id as string;
  }
  const text = (got: Array<{ event: string; data: any }>, conversationId: string) =>
    got
      .filter((e) => e.event === 'message.delta' && e.data.conversationId === conversationId)
      .sort((a, b) => a.data.offset - b.data.offset)
      .map((e) => e.data.delta)
      .join('');

  it('prywatna rozmowa: fragmenty tylko u właściciela i składają się w pełną odpowiedź', async () => {
    const a = await open(alfa.cookie);
    const b = await open(beta.cookie);
    try {
      const conv = await turn(alfa, 'private');
      expect(text(a.got, conv)).toBe(REPLY);
      expect(a.got.find((e) => e.event === 'message.delta')!.data).toMatchObject({
        step: 'reply',
        attempt: 0,
        offset: 0,
      });
      expect(b.got.filter((e) => e.event === 'message.delta')).toEqual([]);
      // Zapisana odpowiedź jest ta sama; fragmenty nie trafiają do tabeli zdarzeń.
      const stored = await t.db.owner.query(
        `SELECT count(*)::int AS n FROM events WHERE type = 'message.delta'`,
      );
      expect(stored.rows[0].n).toBe(0);
    } finally {
      a.close();
      b.close();
    }
  });

  it('rozmowa wspólna: fragmenty widzą domownicy', async () => {
    const b = await open(beta.cookie);
    try {
      const conv = await turn(alfa, 'shared');
      expect(text(b.got, conv)).toBe(REPLY);
    } finally {
      b.close();
    }
  });
});
