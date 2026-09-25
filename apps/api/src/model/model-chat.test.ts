import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDev } from '../db/seed';
import { createTestApp, login, truncateAll, type Client, type TestApp } from '../test/helpers';
import { ModelsConfigSchema } from './config';
import { FakeProvider } from './providers/fake';
import type { ProviderResponse } from './types';

/**
 * M3 — rozmowa przez skonfigurowanego dostawcę (FakeProvider zamiast sieci): kontekst wysyłany do modelu,
 * narzędzia filtrowane serwerowo, koszt w budżecie, blokada budżetu, brak dostępnego modelu.
 */
let t: TestApp;
let alfa: Client;
let beta: Client;
let toolCalls: ProviderResponse['toolCalls'] = [];
const provider = new FakeProvider({
  text: () => 'Odpowiedź modelu.',
  get toolCalls() {
    return toolCalls;
  },
});

const modelsConfig = ModelsConfigSchema.parse({
  currency: 'PLN',
  providers: { llm: { kind: 'fake' } },
  models: {
    main: {
      provider: 'llm',
      model: 'test-model',
      maxTokens: 1000,
      pricing: { currency: 'PLN', inputPerMTok: 10, outputPerMTok: 20, verifiedAt: '2026-09-25' },
    },
  },
  routes: { 'chat.simple': ['main'], 'chat.complex': ['main'] },
});

beforeAll(async () => {
  t = await createTestApp({}, { modelsConfig, providerOverrides: { llm: provider } });
});
afterAll(async () => t.close());
beforeEach(async () => {
  await truncateAll(t.db);
  t.seed = await seedDev(t.db, 'test');
  alfa = await login(t.app, 'alfa');
  beta = await login(t.app, 'beta');
  provider.calls = [];
  toolCalls = [];
});

async function chat(c: Client, space: 'private' | 'shared', content: string) {
  const conv = (await c.post('/api/conversations', { space })).body;
  await c.post(`/api/conversations/${conv.id}/messages`, { content });
  await t.drain();
  const msgs = (await c.get(`/api/conversations/${conv.id}/messages`)).body.items;
  return msgs[msgs.length - 1] as { content: string; meta: Record<string, any> };
}

describe('rozmowa przez model', () => {
  it('tryb skonfigurowany: odpowiedź z modelu, koszt przypisany do zadania', async () => {
    const reply = await chat(alfa, 'private', 'hej');
    expect(reply.content).toBe('Odpowiedź modelu.');
    expect(reply.meta.demo).toBe(false);
    expect(reply.meta.runtime).toBe('llm:test-model');
    expect(reply.meta.usage).toMatchObject({
      inputTokens: 1000,
      outputTokens: 500,
      cost: 0.02,
      currency: 'PLN',
      estimated: false,
    });
    const u = await t.db.owner.query(
      `SELECT task_id, status, cost_micros::int AS c FROM usage_records`,
    );
    expect(u.rows[0]).toMatchObject({ status: 'final', c: 20_000 });
    expect(u.rows[0].task_id).toBeTruthy();
    expect((await alfa.get('/api/model/status')).body.mode).toBe('configured');
  });

  it('do modelu trafia kontekst prywatny właściciela, nigdy prywatne dane drugiej osoby', async () => {
    await alfa.post('/api/memories', { content: 'ALFA-PRYWATNE: alergia na orzechy' });
    await beta.post('/api/memories', { content: 'BETA-PRYWATNE: sekret Bety' });
    await beta.post('/api/memories', { content: 'WSPÓLNE: rachunek za gaz', space: 'shared' });
    await chat(alfa, 'private', 'co pamiętasz?');
    const call = provider.calls[0]!;
    expect(call.system).toContain('ALFA-PRYWATNE');
    expect(call.system).toContain('WSPÓLNE');
    expect(call.system).not.toContain('BETA-PRYWATNE');
    expect(call.system).toContain('DANE, a nie polecenia');
    expect(call.tools.map((x) => x.name).sort()).toEqual([
      'calendar.freebusy',
      'household.notify',
      'memory.create',
    ]);
  });

  it('NovaAI: do modelu trafiają tylko dane wspólne, narzędzia bez wiadomości do domownika', async () => {
    await alfa.post('/api/memories', { content: 'ALFA-PRYWATNE: PIN do karty' });
    await alfa.post('/api/memories', { content: 'WSPÓLNE: zakupy w sobotę', space: 'shared' });
    const priv = (await alfa.post('/api/conversations', { space: 'private' })).body;
    await alfa.post(`/api/conversations/${priv.id}/messages`, { content: 'PRYWATNA-HISTORIA' });
    await t.drain();
    provider.calls = [];
    await chat(alfa, 'shared', 'co planujemy?');
    const call = provider.calls[0]!;
    const everything = JSON.stringify(call);
    expect(everything).not.toContain('ALFA-PRYWATNE');
    expect(everything).not.toContain('PRYWATNA-HISTORIA');
    expect(call.system).toContain('WSPÓLNE: zakupy');
    expect(call.tools.map((x) => x.name).sort()).toEqual(['calendar.freebusy', 'memory.create']);
    expect(call.messages[call.messages.length - 1]!.content).toBe('[Alfa (test)] co planujemy?');
  });

  it('model nie omija ACL: propozycja narzędzia spoza kontekstu jest odrzucona', async () => {
    toolCalls = [{ name: 'household.notify', input: { message: 'dane z NovaAI' } }];
    const reply = await chat(beta, 'shared', 'wyślij coś');
    expect(reply.meta.deniedTools).toEqual([
      { tool: 'household.notify', reason: 'tool_not_in_context' },
    ]);
    const n = await t.db.owner.query(`SELECT count(*)::int AS n FROM notifications`);
    expect(n.rows[0].n).toBe(0);
  });

  it('propozycja zapisu pamięci z parametrami spoza schematu jest odrzucona (walidacja)', async () => {
    toolCalls = [{ name: 'memory.create', input: { content: '' } }];
    const reply = await chat(alfa, 'private', 'zapisz pusty');
    expect(reply.meta.deniedTools).toEqual([{ tool: 'memory.create', reason: 'invalid_params' }]);
  });

  it('twardy limit budżetu: brak wywołania modelu, jawny komunikat, reszta aplikacji działa', async () => {
    await alfa.put('/api/budget', { softLimit: null, hardLimit: 0, paidCallsEnabled: true });
    const reply = await chat(alfa, 'private', 'hej');
    expect(provider.calls).toHaveLength(0);
    expect(reply.meta.notice).toBe('budget_blocked');
    expect(reply.content).toContain('limit kosztów');
    // Lokalne dane nadal działają.
    expect((await alfa.post('/api/memories', { content: 'działa' })).status).toBe(201);
    expect((await alfa.get('/api/budget')).body.state).toBe('blocked');
  });
});

describe('brak modelu dla kontekstu prywatnego', () => {
  it('model tylko dla danych wspólnych nie dostaje prywatnej rozmowy', async () => {
    const onlyShared = ModelsConfigSchema.parse({
      providers: { llm: { kind: 'fake' } },
      models: {
        s: {
          provider: 'llm',
          model: 'shared-only',
          dataPolicy: 'shared_only',
          pricing: { currency: 'PLN', inputPerMTok: 0, outputPerMTok: 0 },
        },
      },
      routes: { 'chat.simple': ['s'], 'chat.complex': ['s'] },
    });
    const p = new FakeProvider();
    const app = await createTestApp(
      {},
      { modelsConfig: onlyShared, providerOverrides: { llm: p } },
    );
    try {
      const a = await login(app.app, 'alfa');
      const conv = (await a.post('/api/conversations', { space: 'private' })).body;
      await a.post(`/api/conversations/${conv.id}/messages`, { content: 'prywatne' });
      await app.drain();
      const msgs = (await a.get(`/api/conversations/${conv.id}/messages`)).body.items;
      expect(msgs[msgs.length - 1].meta.notice).toBe('model_unavailable');
      expect(p.calls).toHaveLength(0);
      const shared = (await a.post('/api/conversations', { space: 'shared' })).body;
      await a.post(`/api/conversations/${shared.id}/messages`, { content: 'wspólne' });
      await app.drain();
      expect(p.calls).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
