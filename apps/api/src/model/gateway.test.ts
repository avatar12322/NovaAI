import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDev } from '../db/seed';
import { createTestApp, login, truncateAll, type Client, type TestApp } from '../test/helpers';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../config';
import { loadModelsConfig, ModelsConfigSchema, type ModelsConfig } from './config';
import {
  BudgetBlocked,
  ModelGateway,
  ModelUnavailable,
  type GatewayRequest,
  type HouseholdOverlay,
} from './gateway';
import { AnthropicProvider } from './providers/anthropic';
import { FakeProvider } from './providers/fake';
import type { ModelProvider, ProviderRequest } from './types';

/** M3 — ModelGateway: dostępność, routing, koszt, budżet (rezerwacje), fallback. */
let t: TestApp;

const cfg = (over: Partial<Record<string, unknown>> = {}): ModelsConfig =>
  ModelsConfigSchema.parse({
    currency: 'PLN',
    fx: { USD: 4 },
    providers: { cheap: { kind: 'fake' }, paid: { kind: 'fake' }, shared: { kind: 'fake' } },
    models: {
      // 10 zł / MTok wejścia, 20 zł / MTok wyjścia => 1000 in + 500 out = 0,02 zł = 20 000 mikro
      paidPLN: {
        provider: 'paid',
        model: 'p1',
        maxTokens: 1000,
        pricing: { currency: 'PLN', inputPerMTok: 10, outputPerMTok: 20, verifiedAt: '2026-09-25' },
      },
      paidUSD: {
        provider: 'paid',
        model: 'p2',
        maxTokens: 1000,
        pricing: { currency: 'USD', inputPerMTok: 1, outputPerMTok: 2, verifiedAt: null },
      },
      free: {
        provider: 'cheap',
        model: 'local',
        maxTokens: 500,
        pricing: { currency: 'PLN', inputPerMTok: 0, outputPerMTok: 0 },
      },
      sharedOnly: {
        provider: 'shared',
        model: 's',
        dataPolicy: 'shared_only',
        pricing: { currency: 'PLN', inputPerMTok: 0, outputPerMTok: 0 },
      },
      noPrice: {
        provider: 'paid',
        model: 'x',
        pricing: { currency: 'PLN', inputPerMTok: null, outputPerMTok: null },
      },
      noFx: {
        provider: 'paid',
        model: 'y',
        pricing: { currency: 'EUR', inputPerMTok: 1, outputPerMTok: 1 },
      },
    },
    routes: {
      'chat.simple': ['paidPLN', 'free'],
      'chat.usd': ['paidUSD'],
      'chat.shared': ['sharedOnly'],
    },
    ...over,
  });

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());
beforeEach(async () => {
  await truncateAll(t.db);
  t.seed = await seedDev(t.db, 'test');
});

const request = (over: Partial<GatewayRequest> = {}): GatewayRequest => ({
  capability: 'chat.simple',
  runtimeProfile: 'private-alfa',
  containsPrivateData: true,
  householdId: t.seed.householdId,
  userId: t.seed.users.alfa,
  system: 'sys',
  messages: [{ role: 'user', content: 'hej' }],
  tools: [],
  ...over,
});

const usageRows = async () =>
  (
    await t.db.owner.query(
      `SELECT provider, model, status, input_tokens, output_tokens, cost_micros::int AS cost, estimated, paid FROM usage_records ORDER BY created_at`,
    )
  ).rows;

/** Stan konfiguracji z pliku (bez dostawców domu) — tak jak widzi go żądanie bez domu. */
const fileSnapshot = (...args: ConstructorParameters<typeof ModelGateway>) =>
  new ModelGateway(...args).snapshot(null);

describe('dostępność modeli', () => {
  it('przykładowa konfiguracja parsuje się i bez cenników/kluczy daje jawny tryb demo', async () => {
    const { config, error } = loadModelsConfig(
      resolve(REPO_ROOT, 'infra/config/models.example.json'),
    );
    expect(error).toBeNull();
    const gw = await fileSnapshot(t.db, config, { ANTHROPIC_API_KEY: 'k' });
    expect(gw.status().mode).toBe('demo');
    expect(gw.availability('claude-strong').reason).toContain('cennika');
    expect(gw.availability('hermes-household').available).toBe(false);
  });

  it('brak cennika, brak kursu i brak klucza czynią model niedostępnym (z powodem)', async () => {
    const gw = await fileSnapshot(t.db, cfg(), {});
    expect(gw.availability('noPrice')).toMatchObject({
      available: false,
      reason: expect.stringContaining('cennika'),
    });
    expect(gw.availability('noFx')).toMatchObject({
      available: false,
      reason: expect.stringContaining('EUR'),
    });
    const withAnthropic = cfg({ providers: { a: { kind: 'anthropic', apiKeyEnv: 'NOPE_KEY' } } });
    const gw2 = await fileSnapshot(
      t.db,
      { ...withAnthropic, models: { m: { ...withAnthropic.models.paidPLN!, provider: 'a' } } },
      {},
    );
    expect(gw2.availability('m')).toMatchObject({
      available: false,
      reason: 'brak klucza (NOPE_KEY)',
    });
    expect(gw2.status().mode).toBe('demo');
  });

  it('profil Hermesa bez potwierdzenia wyłączonych toolsetów jest niedostępny', async () => {
    const c = cfg({
      providers: {
        h: {
          kind: 'openai_compatible',
          apiKeyEnv: 'HK',
          baseUrl: 'http://127.0.0.1:1/v1',
          hermes: { toolsetsDisabledConfirmed: false },
        },
      },
    });
    const gw = await fileSnapshot(
      t.db,
      { ...c, models: { hm: { ...c.models.free!, provider: 'h' } } },
      { HK: 'k' },
    );
    expect(gw.availability('hm').reason).toContain('toolsetów');
  });

  it('kontekst prywatny nie trafia do modelu „shared_only”', async () => {
    const gw = await fileSnapshot(t.db, cfg(), {});
    expect(gw.candidates('chat.shared', 'x', true)).toEqual([]);
    expect(gw.candidates('chat.shared', 'x', false)).toEqual(['sharedOnly']);
  });
});

describe('modele dodane w aplikacji (nakładka domu)', () => {
  const overlay = (): HouseholdOverlay => ({
    providers: {
      home: {
        kind: 'openai_compatible',
        baseUrl: 'https://m.example.test/v1',
        apiKey: 'k',
        enabled: true,
      },
      broken: {
        kind: 'openai_compatible',
        baseUrl: 'https://m.example.test/v1',
        apiKey: null,
        enabled: true,
        error: 'nie można odszyfrować klucza',
      },
      // Ta sama nazwa co w pliku: dostawca z aplikacji zastępuje go dla tego domu.
      paid: { kind: 'anthropic', baseUrl: null, apiKey: 'k', enabled: true },
      // Wyłączony dostawca domu niczego nie zastępuje — zostaje dostawca z pliku.
      cheap: { kind: 'anthropic', baseUrl: null, apiKey: 'k', enabled: false },
    },
    models: {
      // Ta sama nazwa co model z pliku: model z aplikacji go zastępuje (także w trasach).
      free: {
        provider: 'home',
        model: 'f',
        maxTokens: 100,
        dataPolicy: 'private_ok',
        pricing: { currency: 'PLN', inputPerMTok: 0, outputPerMTok: 0 },
        routes: ['chat.complex'],
        priority: 5,
      },
      homeB: {
        provider: 'home',
        model: 'b',
        maxTokens: 100,
        dataPolicy: 'private_ok',
        pricing: { currency: 'PLN', inputPerMTok: 1, outputPerMTok: 1 },
        routes: ['chat.simple'],
        priority: 20,
      },
      homeA: {
        provider: 'home',
        model: 'a',
        maxTokens: 100,
        dataPolicy: 'private_ok',
        pricing: { currency: 'GBP', inputPerMTok: 1, outputPerMTok: 1 },
        routes: ['chat.simple', 'chat.complex'],
        priority: 10,
      },
      viaBroken: {
        provider: 'broken',
        model: 'c',
        maxTokens: 100,
        dataPolicy: 'private_ok',
        pricing: { currency: 'PLN', inputPerMTok: 1, outputPerMTok: 1 },
        routes: ['chat.simple'],
        priority: 1,
      },
    },
    fx: { GBP: 5 },
  });

  it('ustawienia domu mają pierwszeństwo przed plikiem; modele domu przed modelami z pliku; trasy profili — zapas', async () => {
    const gw = new ModelGateway(
      t.db,
      cfg({ profileRoutes: { hermes: { 'chat.simple': ['free'] } } }),
      {},
      { shared: new FakeProvider() },
    );
    const seen: string[] = [];
    gw.useHouseholdSource({
      load: async (hh) => {
        seen.push(hh);
        return overlay();
      },
    });
    const snap = await gw.snapshot(t.seed.householdId);
    expect(snap.config.routes['chat.simple']).toEqual(['viaBroken', 'homeA', 'homeB', 'paidPLN']);
    expect(snap.config.routes['chat.complex']).toEqual(['free', 'homeA']);
    expect(snap.config.routes['chat.usd']).toEqual(['paidUSD']);
    expect(snap.config.profileRoutes.hermes!['chat.simple']).toEqual([
      'viaBroken',
      'homeA',
      'homeB',
    ]);
    expect(snap.config.models.free).toMatchObject({ provider: 'home', model: 'f' });
    // Dostawca „paid” z pliku zastąpiony dostawcą z aplikacji; wyłączony „cheap” — bez zmian.
    expect(snap.providers.get('paid')).toBeInstanceOf(AnthropicProvider);
    expect(snap.providers.get('cheap')).toBeInstanceOf(FakeProvider);
    expect(snap.availability('viaBroken')).toMatchObject({
      available: false,
      reason: 'nie można odszyfrować klucza',
    });
    expect(snap.availability('homeA').available).toBe(true); // kurs GBP z domu
    expect(snap.candidates('chat.simple', 'x', true)).toEqual(['homeA', 'homeB', 'paidPLN']);
    // Plik bez zmian dla innych domów i dla stanu bez domu.
    const base = await gw.snapshot(null);
    expect(base.config.routes['chat.simple']).toEqual(['paidPLN', 'free']);
    expect(base.providers.get('paid')).toBeInstanceOf(FakeProvider);
    // Pamięć podręczna do czasu unieważnienia.
    await gw.snapshot(t.seed.householdId);
    expect(seen).toHaveLength(1);
    gw.invalidate(t.seed.householdId);
    await gw.snapshot(t.seed.householdId);
    expect(seen).toHaveLength(2);
  });
});

describe('koszt i zapis zużycia', () => {
  it('rzeczywisty koszt z usage: tokeny × cena × kurs, rezerwacja rozliczona', async () => {
    const gw = new ModelGateway(t.db, cfg(), {}, { paid: new FakeProvider() });
    const r = await gw.complete(request());
    expect(r).toMatchObject({
      modelKey: 'paidPLN',
      costMicros: 20_000,
      estimated: false,
      paid: true,
    });
    expect(await usageRows()).toEqual([
      {
        provider: 'paid',
        model: 'p1',
        status: 'final',
        input_tokens: 1000,
        output_tokens: 500,
        cost: 20_000,
        estimated: false,
        paid: true,
      },
    ]);
    const usd = await gw.complete(request({ capability: 'chat.usd' }));
    // 1000×1 + 500×2 = 2000 mikro USD × 4 = 8000 mikro PLN
    expect(usd.costMicros).toBe(8_000);
  });

  it('wyszukiwanie w internecie: tylko Anthropic z ceną; koszt wyszukań w budżecie; zasady w instrukcjach', async () => {
    const seen: ProviderRequest[] = [];
    // Dostawca udający Anthropic (bez sieci): 2 wyszukania w odpowiedzi.
    const anthropicLike: ModelProvider = {
      kind: 'anthropic',
      async complete(r) {
        seen.push(r);
        return {
          text: 'Jutro 14°C.',
          toolCalls: [],
          usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
          stopReason: 'end_turn',
          webSearches: 2,
          webSources: [{ url: 'https://pogoda.example', title: 'Pogoda' }],
        };
      },
    };
    const base = cfg();
    const config = ModelsConfigSchema.parse({
      ...base,
      models: {
        ...base.models,
        // 10 USD za 1000 wyszukań, kurs 4 => 1 wyszukanie = 0,04 zł = 40 000 mikro
        search: {
          provider: 'paid',
          model: 'claude-test',
          maxTokens: 1000,
          pricing: { currency: 'USD', inputPerMTok: 1, outputPerMTok: 2, webSearchPer1k: 10 },
        },
      },
      routes: { ...base.routes, 'chat.search': ['search'] },
    });
    const gw = new ModelGateway(t.db, config, {}, { paid: anthropicLike });
    const r = await gw.complete(request({ capability: 'chat.search', webSearch: true }));
    expect(seen[0]!.webSearch).toEqual({ maxUses: 3 });
    expect(seen[0]!.system).toMatch(/^sys\n\nWyszukiwanie w internecie \(web_search\) jest płatne/);
    // Tokeny: (1000×1 + 500×2) × 4 = 8000; wyszukania: 2 × 40 000 = 80 000.
    expect(r).toMatchObject({ costMicros: 88_000, webSearches: 2, paid: true });
    expect(r.webSources).toEqual([{ url: 'https://pogoda.example', title: 'Pogoda' }]);

    // Bez zgody na wyszukiwanie w tej turze albo bez ceny w cenniku — bez narzędzia i bez zasad.
    await gw.complete(request({ capability: 'chat.search', webSearch: false }));
    await gw.complete(request({ webSearch: true }));
    for (const x of seen.slice(1)) {
      expect(x.webSearch).toBeUndefined();
      expect(x.system).toBe('sys');
    }
  });

  it('brak metadanych usage => koszt oznaczony jako estymacja', async () => {
    const gw = new ModelGateway(t.db, cfg(), {}, { paid: new FakeProvider({ usage: 'none' }) });
    const r = await gw.complete(request());
    expect(r.estimated).toBe(true);
    expect((await usageRows())[0]).toMatchObject({ estimated: true, status: 'final' });
    const b = await gw.budget.status(t.seed.householdId);
    expect(b.estimatedShare).toBeGreaterThan(0);
  });

  it('błąd ponawialny => kolejny model z trasy; nieudana rezerwacja nie kosztuje', async () => {
    const gw = new ModelGateway(
      t.db,
      cfg(),
      {},
      { paid: new FakeProvider({ fail: 'retryable' }), cheap: new FakeProvider() },
    );
    const r = await gw.complete(request());
    expect(r.modelKey).toBe('free');
    const rows = await usageRows();
    expect(rows.map((x) => [x.model, x.status, x.cost])).toEqual([
      ['p1', 'failed', 0],
      ['local', 'final', 0],
    ]);
  });

  it('brak kandydatów => ModelUnavailable', async () => {
    const gw = new ModelGateway(t.db, cfg(), {});
    await expect(gw.complete(request({ capability: 'nieznana' }))).rejects.toBeInstanceOf(
      ModelUnavailable,
    );
  });
});

describe('budżet', () => {
  it('twardy limit blokuje płatne wywołanie PRZED wysłaniem i emituje budget.blocked', async () => {
    const fake = new FakeProvider();
    const gw = new ModelGateway(
      t.db,
      cfg({ routes: { 'chat.simple': ['paidPLN'] } }),
      {},
      { paid: fake },
    );
    await gw.budget.update(t.seed.householdId, t.seed.users.alfa, {
      softLimit: null,
      hardLimit: 0.01,
      paidCallsEnabled: true,
    });
    await expect(gw.complete(request())).rejects.toBeInstanceOf(BudgetBlocked);
    expect(fake.calls).toHaveLength(0);
    const ev = await t.db.owner.query(`SELECT payload FROM events WHERE type = 'budget.blocked'`);
    expect(ev.rows[0].payload).toEqual({ reason: 'hard_limit' });
  });

  it('wyłączenie płatnych wywołań blokuje modele płatne, ale nie bezpłatne', async () => {
    const gw = new ModelGateway(
      t.db,
      cfg(),
      {},
      { paid: new FakeProvider(), cheap: new FakeProvider() },
    );
    await gw.budget.update(t.seed.householdId, t.seed.users.alfa, {
      softLimit: null,
      hardLimit: null,
      paidCallsEnabled: false,
    });
    await expect(gw.complete(request({ capability: 'chat.usd' }))).rejects.toBeInstanceOf(
      BudgetBlocked,
    );
    const r = await gw.complete(request()).catch((e: unknown) => e);
    // chat.simple: paidPLN zablokowany => BudgetBlocked (blokada budżetu nie przechodzi do kolejnych modeli)
    expect(r).toBeInstanceOf(BudgetBlocked);
    const free = await new ModelGateway(
      t.db,
      cfg({ routes: { f: ['free'] } }),
      {},
      { cheap: new FakeProvider() },
    ).complete(request({ capability: 'f' }));
    expect(free.paid).toBe(false);
  });

  it('równoległe wywołania nie przekraczają twardego limitu (rezerwacja najgorszego przypadku)', async () => {
    const slow = new FakeProvider({ text: () => 'ok' });
    const gw = new ModelGateway(
      t.db,
      cfg({ routes: { 'chat.simple': ['paidPLN'] } }),
      {},
      { paid: slow },
    );
    // Najgorszy przypadek jednego wywołania: ~(prompt/3)×10 + 1000×20 mikro ≈ 0,02 zł. Limit mieści jedno.
    await gw.budget.update(t.seed.householdId, t.seed.users.alfa, {
      softLimit: null,
      hardLimit: 0.03,
      paidCallsEnabled: true,
    });
    const results = await Promise.allSettled([
      gw.complete(request()),
      gw.complete(request()),
      gw.complete(request()),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const blocked = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof BudgetBlocked,
    ).length;
    expect(ok).toBe(1);
    expect(blocked).toBe(2);
    const b = await gw.budget.status(t.seed.householdId);
    expect(b.spent).toBeLessThanOrEqual(0.03);
  });

  it('przekroczenie progu ostrzeżenia emituje budget.warning dokładnie raz', async () => {
    const gw = new ModelGateway(
      t.db,
      cfg({ routes: { 'chat.simple': ['paidPLN'] } }),
      {},
      { paid: new FakeProvider() },
    );
    await gw.budget.update(t.seed.householdId, t.seed.users.alfa, {
      softLimit: 0.03,
      hardLimit: null,
      paidCallsEnabled: true,
    });
    for (let i = 0; i < 3; i++) await gw.complete(request());
    const ev = await t.db.owner.query(
      `SELECT count(*)::int AS n FROM events WHERE type = 'budget.warning'`,
    );
    expect(ev.rows[0].n).toBe(1);
    expect((await gw.budget.status(t.seed.householdId)).state).toBe('warning');
  });
});

describe('API budżetu i statusu modeli', () => {
  let alfa: Client;
  let beta: Client;
  beforeEach(async () => {
    alfa = await login(t.app, 'alfa');
    beta = await login(t.app, 'beta');
  });

  it('GET/PUT /api/budget: walidacja, audyt, wspólny widok domu', async () => {
    expect((await alfa.get('/api/budget')).body).toMatchObject({
      currency: 'PLN',
      spent: 0,
      state: 'ok',
      paidCallsEnabled: true,
    });
    expect(
      (await alfa.put('/api/budget', { softLimit: 200, hardLimit: 100, paidCallsEnabled: true }))
        .status,
    ).toBe(400);
    const r = await alfa.put('/api/budget', {
      softLimit: 100,
      hardLimit: 150,
      paidCallsEnabled: true,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ softLimit: 100, hardLimit: 150 });
    expect((await beta.get('/api/budget')).body).toMatchObject({ softLimit: 100, hardLimit: 150 });
    // Domownik widzi limit, ale go nie zmienia (ustawia właściciel domu).
    const denied = await beta.put('/api/budget', {
      softLimit: null,
      hardLimit: null,
      paidCallsEnabled: true,
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toContain('tylko właściciel domu');
    const audit = await t.db.owner.query(
      `SELECT actor_user_id FROM audit_log WHERE action = 'budget.update'`,
    );
    expect(audit.rows[0].actor_user_id).toBe(t.seed.users.alfa);
  });

  it('GET /api/model/status nie ujawnia sekretów i pokazuje tryb demo', async () => {
    const s = await alfa.get('/api/model/status');
    expect(s.status).toBe(200);
    expect(s.body.mode).toBe('demo');
    expect(s.body.runtime).toBe('fake');
    expect(JSON.stringify(s.body)).not.toMatch(/sk-|api[_-]?key/i);
  });
});
