import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deriveKey, Vault } from '../connectors/vault';
import { createHousehold } from '../db/admin';
import { withUserTx } from '../db/pool';
import { seedDev } from '../db/seed';
import { createTestApp, login, truncateAll, type Client, type TestApp } from '../test/helpers';
import { ModelsConfigSchema } from './config';
import { DbHouseholdModels, rotateProviderKeys } from './household';

/**
 * „Modele AI i klucze API”: dostawcy dodawani w aplikacji. Wyłącznie lokalny serwer-mock (bez sieci,
 * bez płatnych API) i klucze testowe. Sprawdza uprawnienia, szyfrowanie, sprawdzenie klucza, rozmowę
 * przez dostawcę bez restartu, koszt w budżecie i w „Usługi i koszty”, powrót do demo, izolację domów.
 */
interface Captured {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: any;
}
const KEY = 'mock-key-0123456789-abcdefWXYZ';
const OTHER_KEY = 'mock-key-9999999999-zzzzzzzzzz';
/** Klucz „z .env serwera” (konfiguracja z pliku) — inny niż wpisany w aplikacji. */
const ENV_KEY = 'mock-env-key-5555555555-ENVKEY';
const VALID = new Set([KEY, ENV_KEY]);
let server: Server;
let base: string;
let captured: Captured[] = [];

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
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const anthropic = c.url.startsWith('/anthropic/');
      const okKey = anthropic
        ? VALID.has(String(c.headers['x-api-key'])) &&
          c.headers['anthropic-version'] === '2023-06-01'
        : c.headers.authorization === `Bearer ${KEY}`;
      if (!okKey) return send(401, { error: { message: 'invalid key' } });
      if (
        c.method === 'GET' &&
        (c.url === '/v1/models' || c.url.startsWith('/anthropic/v1/models'))
      )
        return send(200, {
          object: 'list',
          data: [
            { id: 'test-model-x' },
            { id: 'models/test-model-y' },
            { id: 'bad id with spaces' },
          ],
          has_more: false,
        });
      if (c.method === 'POST' && c.url === '/anthropic/v1/messages')
        return send(200, {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: c.body.model,
          content: [{ type: 'text', text: 'Odpowiedź Claude (atrapa).' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1000, output_tokens: 500 },
        });
      if (c.method === 'POST' && c.url === '/v1/chat/completions')
        return send(200, {
          choices: [{ finish_reason: 'stop', message: { content: 'Odpowiedź z modelu domu.' } }],
          usage: { prompt_tokens: 1000, completion_tokens: 500 },
        });
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

// Plik konfiguracyjny serwera: dostawca bez modeli (nazwa zajęta), brak dostępnych modeli => demo.
const modelsConfig = ModelsConfigSchema.parse({
  currency: 'PLN',
  providers: { filellm: { kind: 'fake' } },
});

let t: TestApp;
let alfa: Client;
let beta: Client;
beforeAll(async () => {
  t = await createTestApp({}, { modelsConfig });
});
afterAll(async () => t.close());
beforeEach(async () => {
  await truncateAll(t.db);
  t.seed = await seedDev(t.db, 'test');
  t.deps.gateway.invalidate(t.seed.householdId);
  alfa = await login(t.app, 'alfa');
  beta = await login(t.app, 'beta');
  captured = [];
});

const addProvider = (c: Client, over: Record<string, unknown> = {}) =>
  c.post('/api/model/providers', {
    name: 'mockai',
    label: 'Mock AI',
    kind: 'openai_compatible',
    baseUrl: `${base}/v1`,
    apiKey: KEY,
    ...over,
  });
const providerOf = (body: any, name: string) => body.providers.find((p: any) => p.name === name);
const providerId = (body: any, name = 'mockai') =>
  body.providers.find((p: any) => p.name === name).id as string;
const addModel = (c: Client, pid: string, over: Record<string, unknown> = {}) =>
  c.post('/api/model/models', {
    providerId: pid,
    name: 'mock-main',
    model: 'test-model-x',
    maxTokens: 1000,
    pricing: { currency: 'USD', inputPerMTok: 1, outputPerMTok: 2, verifiedAt: '2026-09-26' },
    ...over,
  });

async function chat(c: Client, space: 'private' | 'shared', content: string) {
  const conv = (await c.post('/api/conversations', { space })).body;
  await c.post(`/api/conversations/${conv.id}/messages`, { content });
  await t.drain();
  const msgs = (await c.get(`/api/conversations/${conv.id}/messages`)).body.items;
  return msgs[msgs.length - 1] as { content: string; meta: Record<string, any> };
}

describe('uprawnienia', () => {
  it('domownik widzi stan (bez kluczy), ale zmienia tylko właściciel domu', async () => {
    const created = await addProvider(alfa);
    expect(created.status).toBe(200);
    const pid = providerId(created.body);
    const view = await beta.get('/api/model/providers');
    expect(view.status).toBe(200);
    expect(view.body.canManage).toBe(false);
    expect(view.body.providers[0]).toMatchObject({ name: 'mockai', hasKey: true, keyHint: 'WXYZ' });
    expect(JSON.stringify(view.body)).not.toContain(KEY);

    for (const r of [
      await addProvider(beta, { name: 'betaai' }),
      await beta.patch(`/api/model/providers/${pid}`, { apiKey: OTHER_KEY }),
      await beta.del(`/api/model/providers/${pid}`),
      await beta.post(`/api/model/providers/${pid}/check`),
      await addModel(beta, pid),
      await beta.put('/api/model/fx', { currency: 'USD', rate: 4 }),
    ]) {
      expect(r.status).toBe(403);
      expect(r.body.error.message).toContain('właściciel domu');
    }
    expect((await alfa.get('/api/model/providers')).body.canManage).toBe(true);
  });

  it('dostawca innego domu jest niewidoczny i niezmienialny', async () => {
    const other = await createHousehold(t.db, 'Inny dom', [
      { email: 'inny@example.test', displayName: 'Inny' },
    ]);
    const r = await t.db.owner.query<{ id: string }>(
      `INSERT INTO model_providers (household_id, name, label, kind, base_url, created_by)
       VALUES ($1, 'obcy', 'Obcy', 'openai_compatible', 'https://obcy.example.test/v1', $2) RETURNING id`,
      [other.householdId, other.userIds[0]],
    );
    const foreign = r.rows[0]!.id;
    expect((await alfa.get('/api/model/providers')).body.providers).toHaveLength(0);
    expect((await alfa.patch(`/api/model/providers/${foreign}`, { label: 'x' })).status).toBe(404);
    expect((await alfa.del(`/api/model/providers/${foreign}`)).status).toBe(404);
    expect((await alfa.post(`/api/model/providers/${foreign}/check`)).status).toBe(404);
    expect((await addModel(alfa, foreign)).status).toBe(404);
    // Model dodany w domu Alfy nie trafia do konfiguracji innego domu.
    const pid = providerId((await addProvider(alfa)).body);
    await addModel(alfa, pid, { pricing: { currency: 'PLN', inputPerMTok: 1, outputPerMTok: 2 } });
    expect((await t.deps.gateway.snapshot(t.seed.householdId)).hasAvailable()).toBe(true);
    const snapOther = await t.deps.gateway.snapshot(other.householdId);
    expect(snapOther.hasAvailable()).toBe(false);
    expect(snapOther.config.models['mock-main']).toBeUndefined();
  });
});

describe('klucz API: tylko do zapisu, zaszyfrowany', () => {
  it('klucz nie wraca w odpowiedziach, nie ma go jawnie w bazie ani w audycie', async () => {
    const r = await addProvider(alfa);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(KEY);
    const p = r.body.providers[0];
    expect(p).toMatchObject({ hasKey: true, keyHint: 'WXYZ', usable: true, reason: null });

    const row = (
      await t.db.owner.query('SELECT key_ciphertext, key_id, key_hint FROM model_providers')
    ).rows[0];
    expect(row.key_id).toBe('k1');
    expect(Buffer.from(row.key_ciphertext).includes(Buffer.from(KEY))).toBe(false);
    const audit = await t.db.owner.query(
      `SELECT action, details::text FROM audit_log WHERE action LIKE 'model_provider.%'`,
    );
    expect(audit.rows.map((a) => a.action)).toEqual(['model_provider.create']);
    expect(audit.rows[0].details).not.toContain(KEY);
    expect(audit.rows[0].details).not.toContain('WXYZ');

    // Rola aplikacji (RLS) nie może odczytać szyfrogramu.
    await expect(
      withUserTx(t.db, { userId: t.seed.users.alfa, scope: 'user' }, (c) =>
        c.query('SELECT key_ciphertext FROM model_providers'),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // Zamiana klucza: nowa wskazówka, stary wynik sprawdzenia skasowany; usunięcie klucza.
    const pid = p.id;
    await alfa.post(`/api/model/providers/${pid}/check`);
    const replaced = await alfa.patch(`/api/model/providers/${pid}`, { apiKey: OTHER_KEY });
    expect(replaced.status).toBe(200);
    expect(replaced.body.providers[0]).toMatchObject({ keyHint: 'zzzz', lastCheck: null });
    expect(JSON.stringify(replaced.body)).not.toContain(OTHER_KEY);
    const removed = await alfa.patch(`/api/model/providers/${pid}`, { removeKey: true });
    // Mock działa na 127.0.0.1 — lokalny serwer może działać bez klucza.
    expect(removed.body.providers[0]).toMatchObject({ hasKey: false, keyHint: null, usable: true });
    // Serwer https bez klucza jest niedostępny dla asystenta.
    const remote = await addProvider(alfa, {
      name: 'remote',
      baseUrl: 'https://models.example.test/v1',
      apiKey: undefined,
    });
    expect(remote.body.providers.find((x: any) => x.name === 'remote')).toMatchObject({
      hasKey: false,
      usable: false,
      reason: 'brak klucza API',
    });
    const all = await t.db.owner.query(`SELECT details::text FROM audit_log`);
    for (const a of all.rows) {
      expect(a.details).not.toContain(KEY);
      expect(a.details).not.toContain(OTHER_KEY);
    }
  });

  it('klucz przeniesiony do innego rekordu nie daje się odszyfrować (AAD)', async () => {
    const a = providerId((await addProvider(alfa)).body);
    const b = providerId(
      (await addProvider(alfa, { name: 'second', apiKey: OTHER_KEY })).body,
      'second',
    );
    await t.db.owner.query(
      `UPDATE model_providers SET key_ciphertext = (SELECT key_ciphertext FROM model_providers WHERE id = $1)
        WHERE id = $2`,
      [a, b],
    );
    t.deps.gateway.invalidate(t.seed.householdId);
    const view = (await alfa.get('/api/model/providers')).body;
    const second = view.providers.find((p: any) => p.id === b);
    expect(second.usable).toBe(false);
    expect(second.reason).toContain('nie można odszyfrować');
    const check = await alfa.post(`/api/model/providers/${b}/check`);
    expect(check.body.ok).toBe(false);
    expect(captured).toHaveLength(0); // żadne żądanie z kluczem nie wyszło
  });

  it('bez NOVA_SECRET_KEY klucza nie da się zapisać (jasny komunikat)', async () => {
    const noVault = await createTestApp({ NOVA_SECRET_KEY: '' }, { modelsConfig });
    try {
      const owner = await login(noVault.app, 'alfa');
      expect((await owner.get('/api/model/providers')).body.vaultReady).toBe(false);
      const r = await owner.post('/api/model/providers', {
        name: 'mockai',
        label: 'Mock AI',
        kind: 'openai_compatible',
        baseUrl: `${base}/v1`,
        apiKey: KEY,
      });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('no_vault');
      expect(r.body.error.message).toContain('NOVA_SECRET_KEY');
      expect((await noVault.db.owner.query('SELECT 1 FROM model_providers')).rowCount).toBe(0);
    } finally {
      await noVault.close();
    }
  });

  it('rotacja NOVA_SECRET_KEY: klucze dostawców są ponownie szyfrowane', async () => {
    await addProvider(alfa);
    const oldKey = t.config.secretKey;
    const newVault = new Vault(
      { id: 'k2', key: deriveKey(Buffer.alloc(32, 9).toString('base64')) },
      [{ id: 'k1', key: deriveKey(oldKey) }],
    );
    expect(await rotateProviderKeys(t.db, newVault)).toBe(1);
    expect(await rotateProviderKeys(t.db, newVault)).toBe(0);
    const row = (await t.db.owner.query('SELECT key_id FROM model_providers')).rows[0];
    expect(row.key_id).toBe('k2');
    // Tylko nowy klucz (bez starego) wystarcza do odczytu.
    const onlyNew = new Vault({ id: 'k2', key: deriveKey(Buffer.alloc(32, 9).toString('base64')) });
    const overlay = await new DbHouseholdModels(t.db, onlyNew, true).load(t.seed.householdId);
    expect(overlay?.providers.mockai).toMatchObject({ apiKey: KEY, error: null });
  });
});

describe('walidacja', () => {
  it('odrzuca niebezpieczne adresy, klucze ze spacjami i nazwy zajęte przez plik konfiguracyjny', async () => {
    const http = await addProvider(alfa, { baseUrl: 'http://example.test/v1' });
    expect(http.status).toBe(400);
    const cred = await addProvider(alfa, { baseUrl: 'https://user:pass@example.test/v1' });
    expect(cred.status).toBe(400);
    const noUrl = await addProvider(alfa, { baseUrl: null });
    expect(noUrl.status).toBe(400);
    expect(noUrl.body.error.message).toContain('adres serwera');
    const spaced = await addProvider(alfa, { apiKey: 'klucz z spacjami 1234567890' });
    expect(spaced.status).toBe(400);
    expect(JSON.stringify(spaced.body)).not.toContain('klucz z spacjami');
    expect(spaced.body.error.details[0].message).toContain('spacji');
    // Nazwa jak u dostawcy z pliku serwera jest dozwolona — dostawca z aplikacji go zastępuje (dla tego domu).
    const same = await addProvider(alfa, { name: 'filellm' });
    expect(same.status).toBe(200);
    expect(providerOf(same.body, 'filellm').overridesServer).toBe(true);
    expect(same.body.serverProviders).toEqual([
      expect.objectContaining({ name: 'filellm', overridden: true }),
    ]);
    expect((await addProvider(alfa)).status).toBe(200);
    const dup = await addProvider(alfa);
    expect(dup.status).toBe(409);
    const pid = providerId((await alfa.get('/api/model/providers')).body);
    const noUse = await addModel(alfa, pid, { useSimple: false, useComplex: false });
    expect(noUse.status).toBe(400);
    const noPrice = await addModel(alfa, pid, { pricing: { currency: 'USD' } });
    expect(noPrice.status).toBe(400);
    const noProvider = await addModel(alfa, pid, { providerId: undefined });
    expect(noProvider.status).toBe(400);
    const unknownServer = await addModel(alfa, pid, {
      providerId: undefined,
      serverProvider: 'nieznany',
    });
    expect(unknownServer.status).toBe(404);
    const budgetCurrency = await alfa.put('/api/model/fx', { currency: 'PLN', rate: 1 });
    expect(budgetCurrency.status).toBe(400);
  });

  it('lokalny serwer (http://localhost) wymaga zgody serwera (NOVA_MODELS_ALLOW_LOCAL)', async () => {
    const strict = await createTestApp({ NOVA_MODELS_ALLOW_LOCAL: 'false' }, { modelsConfig });
    try {
      const owner = await login(strict.app, 'alfa');
      const r = await owner.post('/api/model/providers', {
        name: 'ollama',
        label: 'Ollama',
        kind: 'openai_compatible',
        baseUrl: 'http://localhost:11434/v1',
      });
      expect(r.status).toBe(400);
      expect(r.body.error.message).toContain('NOVA_MODELS_ALLOW_LOCAL');
    } finally {
      await strict.close();
    }
  });
});

describe('sprawdzenie klucza (lista modeli, bez kosztów)', () => {
  it('zgodny z OpenAI: poprawny klucz — lista modeli; zły klucz — odrzucony', async () => {
    const pid = providerId((await addProvider(alfa)).body);
    const ok = await alfa.post(`/api/model/providers/${pid}/check`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, models: ['test-model-x', 'test-model-y'] });
    expect(captured[0]).toMatchObject({ method: 'GET', url: '/v1/models' });
    expect(captured[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    const view = (await alfa.get('/api/model/providers')).body;
    expect(view.providers[0].lastCheck).toMatchObject({ ok: true });

    await alfa.patch(`/api/model/providers/${pid}`, { apiKey: OTHER_KEY });
    const bad = await alfa.post(`/api/model/providers/${pid}/check`);
    expect(bad.body).toMatchObject({ ok: false, models: [] });
    expect(bad.body.message).toContain('odrzucił klucz (HTTP 401)');
    expect(JSON.stringify(bad.body)).not.toContain('invalid key'); // treść odpowiedzi dostawcy nie wraca
  });

  it('Anthropic: GET /v1/models z x-api-key i anthropic-version', async () => {
    const r = await addProvider(alfa, {
      name: 'claude',
      kind: 'anthropic',
      baseUrl: `${base}/anthropic`,
    });
    const pid = providerId(r.body, 'claude');
    const ok = await alfa.post(`/api/model/providers/${pid}/check`);
    expect(ok.body.ok).toBe(true);
    expect(captured[0]!.url).toBe('/anthropic/v1/models?limit=1000');
    expect(captured[0]!.headers['x-api-key']).toBe(KEY);
    expect(captured[0]!.headers.authorization).toBeUndefined();
  });

  it('serwer niedostępny — czytelny komunikat', async () => {
    const pid = providerId((await addProvider(alfa, { baseUrl: 'http://127.0.0.1:9/v1' })).body);
    const r = await alfa.post(`/api/model/providers/${pid}/check`);
    expect(r.body).toMatchObject({ ok: false });
    expect(r.body.message).toContain('Brak połączenia');
  });
});

describe('rozmowa przez dostawcę dodanego w aplikacji', () => {
  it('bez restartu: demo → model (koszt pod nazwą dostawcy, kurs waluty) → demo po usunięciu', async () => {
    expect((await alfa.get('/api/model/status')).body).toMatchObject({
      mode: 'demo',
      runtime: 'fake',
    });
    expect((await chat(alfa, 'private', 'hej')).meta.demo).toBe(true);

    const pid = providerId((await addProvider(alfa)).body);
    const withModel = await addModel(alfa, pid);
    expect(withModel.status).toBe(200);
    // Cennik w USD bez kursu do PLN — model niedostępny, UI prosi o kurs.
    expect(withModel.body.missingFx).toEqual(['USD']);
    expect(withModel.body.models[0]).toMatchObject({ available: false });
    expect(withModel.body.models[0].reason).toContain('USD');
    expect(withModel.body.mode).toBe('demo');

    const fx = await alfa.put('/api/model/fx', { currency: 'USD', rate: 4 });
    expect(fx.body).toMatchObject({ mode: 'configured', missingFx: [] });
    expect(fx.body.models[0]).toMatchObject({ available: true, reason: null });
    expect((await alfa.get('/api/model/status')).body).toMatchObject({
      mode: 'configured',
      runtime: 'model',
    });
    expect((await beta.get('/api/health')).body.model).toMatchObject({
      mode: 'configured',
      providers: ['mock-main'],
    });
    // Bez sesji /health nie zdradza konfiguracji domu.
    const anon = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(JSON.parse(anon.body).model).toMatchObject({ mode: 'demo', providers: [] });

    const svc = await alfa.post('/api/services', {
      name: 'Mock AI',
      category: 'model_api',
      billingPeriod: 'usage',
      currency: 'PLN',
      modelProvider: 'mockai',
    });
    expect(svc.status).toBe(201);

    const reply = await chat(alfa, 'private', 'hej');
    expect(reply.content).toBe('Odpowiedź z modelu domu.');
    expect(reply.meta.demo).toBe(false);
    const call = captured.find((c) => c.url === '/v1/chat/completions')!;
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call.body.model).toBe('test-model-x');
    expect(call.body.max_tokens).toBe(1000);
    // 1000 × 1 USD + 500 × 2 USD za MTok = 0,002 USD × 4 = 0,008 PLN.
    const u = await t.db.owner.query(
      `SELECT provider, model, cost_micros::int AS c, currency, paid FROM usage_records WHERE status = 'final'`,
    );
    expect(u.rows).toEqual([
      { provider: 'mockai', model: 'test-model-x', c: 8000, currency: 'PLN', paid: true },
    ]);
    const detail = (await alfa.get(`/api/services/${svc.body.id}`)).body;
    expect(detail.current.modelEstimate).toEqual([{ currency: 'PLN', micros: 8000 }]);

    // Model wyłączony => demo; włączony ponownie => model; usunięcie dostawcy => demo.
    const mid = withModel.body.models[0].id;
    expect((await alfa.patch(`/api/model/models/${mid}`, { enabled: false })).body.mode).toBe(
      'demo',
    );
    expect((await alfa.patch(`/api/model/models/${mid}`, { enabled: true })).body.mode).toBe(
      'configured',
    );
    const del = await alfa.del(`/api/model/providers/${pid}`);
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ mode: 'demo', providers: [], models: [] });
    expect((await chat(alfa, 'private', 'hej')).meta.demo).toBe(true);
  });

  it('model „tylko dane wspólne” nie dostaje prywatnej rozmowy', async () => {
    const pid = providerId((await addProvider(alfa)).body);
    await addModel(alfa, pid, {
      dataPolicy: 'shared_only',
      pricing: { currency: 'PLN', inputPerMTok: 1, outputPerMTok: 2 },
    });
    const priv = await chat(alfa, 'private', 'hej');
    expect(priv.meta.notice).toBe('model_unavailable');
    expect(captured.filter((c) => c.url === '/v1/chat/completions')).toHaveLength(0);
    const shared = await chat(alfa, 'shared', 'hej');
    expect(shared.content).toBe('Odpowiedź z modelu domu.');
  });
});

describe('konfiguracja serwera (plik + klucz w .env) i aplikacja', () => {
  it('klucz z .env bez cennika => czytelny stan; preset „anthropic” działa; model na kluczu serwera; aplikacja ma pierwszeństwo', async () => {
    // Jak infra/config/models.example.json: dostawca „anthropic” (klucz ze zmiennej), model bez cennika.
    const serverConfig = ModelsConfigSchema.parse({
      currency: 'PLN',
      fx: { USD: null },
      providers: {
        anthropic: {
          kind: 'anthropic',
          apiKeyEnv: 'MOCK_ANTHROPIC_API_KEY',
          baseUrl: `${base}/anthropic`,
        },
        hermes: { kind: 'openai_compatible', apiKeyEnv: 'MOCK_HERMES_KEY', baseUrl: `${base}/v1` },
      },
      models: {
        'claude-fast': {
          provider: 'anthropic',
          model: 'claude-haiku-test',
          pricing: { currency: 'USD', inputPerMTok: null, outputPerMTok: null },
        },
        // Z cennikiem, ale bez kursu USD→PLN (poza trasami) — waluta trafia do „Kursy walut”.
        'claude-usd': {
          provider: 'anthropic',
          model: 'claude-usd-test',
          pricing: { currency: 'USD', inputPerMTok: 1, outputPerMTok: 2 },
        },
      },
      routes: { 'chat.simple': ['claude-fast'], 'chat.complex': ['claude-fast'] },
    });
    const s = await createTestApp(
      {},
      { modelsConfig: serverConfig, env: { MOCK_ANTHROPIC_API_KEY: ENV_KEY } },
    );
    try {
      const owner = await login(s.app, 'alfa');
      const talk = async () => {
        const conv = (await owner.post('/api/conversations', { space: 'private' })).body;
        await owner.post(`/api/conversations/${conv.id}/messages`, { content: 'hej' });
        await s.drain();
        const msgs = (await owner.get(`/api/conversations/${conv.id}/messages`)).body.items;
        return msgs[msgs.length - 1] as { content: string; meta: Record<string, any> };
      };
      const lastKey = () =>
        captured.filter((c) => c.url === '/anthropic/v1/messages').at(-1)?.headers['x-api-key'];

      // Stan: klucz z .env wczytany, ale model z pliku bez cennika — tryb demo z konkretnym powodem.
      const view = (await owner.get('/api/model/providers')).body;
      expect(view.mode).toBe('demo');
      expect(view.serverProviders).toEqual([
        {
          name: 'anthropic',
          kind: 'anthropic',
          keyEnv: 'MOCK_ANTHROPIC_API_KEY',
          usable: true,
          reason: null,
          overridden: false,
        },
        {
          name: 'hermes',
          kind: 'openai_compatible',
          keyEnv: 'MOCK_HERMES_KEY',
          usable: false,
          reason: 'brak klucza (MOCK_HERMES_KEY)',
          overridden: false,
        },
      ]);
      expect(view.fileModels[0]).toMatchObject({
        key: 'claude-fast',
        available: false,
        overridden: false,
      });
      expect(view.fileModels[0].reason).toContain('brak cennika');
      expect(view.fileModels[1]).toMatchObject({ key: 'claude-usd', available: false });
      expect(view.missingFx).toEqual(['USD']);
      expect(JSON.stringify(view)).not.toContain(ENV_KEY);

      // Model z cennikiem na dostawcy serwera (klucz z .env, bez ponownego wpisywania) — zastępuje „claude-fast”.
      const added = await owner.post('/api/model/models', {
        serverProvider: 'anthropic',
        name: 'claude-fast',
        model: 'claude-haiku-test',
        pricing: { currency: 'PLN', inputPerMTok: 1, outputPerMTok: 2 },
      });
      expect(added.status).toBe(200);
      expect(added.body.mode).toBe('configured');
      expect(added.body.models[0]).toMatchObject({
        providerId: null,
        providerName: 'anthropic',
        serverProvider: true,
        overridesServer: true,
        available: true,
      });
      expect(added.body.fileModels[0]).toMatchObject({ overridden: true, available: false });
      let reply = await talk();
      expect(reply.content).toBe('Odpowiedź Claude (atrapa).');
      expect(lastKey()).toBe(ENV_KEY);
      const cost = await s.db.owner.query(
        `SELECT provider, cost_micros::int AS c FROM usage_records WHERE status = 'final'`,
      );
      expect(cost.rows).toEqual([{ provider: 'anthropic', c: 2000 }]); // 1000×1 + 500×2 zł / MTok

      // Preset „anthropic” w aplikacji (ta sama nazwa co w pliku) — bez błędu; jego klucz ma pierwszeństwo.
      const own = await owner.post('/api/model/providers', {
        name: 'anthropic',
        label: 'Anthropic (Claude)',
        kind: 'anthropic',
        baseUrl: `${base}/anthropic`,
        apiKey: KEY,
      });
      expect(own.status).toBe(200);
      expect(providerOf(own.body, 'anthropic')).toMatchObject({
        overridesServer: true,
        usable: true,
      });
      expect(own.body.serverProviders[0]).toMatchObject({ name: 'anthropic', overridden: true });
      reply = await talk();
      expect(reply.content).toBe('Odpowiedź Claude (atrapa).');
      expect(lastKey()).toBe(KEY);

      // Wyłączony dostawca z aplikacji => znów klucz serwera; usunięty => model na dostawcy serwera zostaje.
      const pid = providerOf(own.body, 'anthropic').id;
      const off = await owner.patch(`/api/model/providers/${pid}`, { enabled: false });
      expect(providerOf(off.body, 'anthropic')).toMatchObject({
        usable: false,
        reason: 'wyłączony — używana konfiguracja serwera',
      });
      await talk();
      expect(lastKey()).toBe(ENV_KEY);
      const del = await owner.del(`/api/model/providers/${pid}`);
      expect(del.body.models).toHaveLength(1);
      expect(del.body.mode).toBe('configured');
      await talk();
      expect(lastKey()).toBe(ENV_KEY);
    } finally {
      await s.close();
    }
  });
});
