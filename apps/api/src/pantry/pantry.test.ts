import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHousehold } from '../db/admin';
import { withUserTx } from '../db/pool';
import { seedDev } from '../db/seed';
import { buildDigest } from '../digest/service';
import { ModelsConfigSchema } from '../model/config';
import { FakeProvider } from '../model/providers/fake';
import type { ProviderResponse } from '../model/types';
import { createTestApp, login, truncateAll, type Client, type TestApp } from '../test/helpers';
import { defaultsFor, listPantry, nameKey, planMeal, productName, statusOf } from './service';

/**
 * Spiżarnia: stan szacowany z zakupów i trwałości (masz / kończy się / raczej nie), uczenie tempa zużycia,
 * odhaczenie na liście → spiżarnia, „pewnie masz” na liście, dania zużywające składniki, przegląd wieczorny,
 * asystent (kontekst i narzędzie). Wspólna dla domu, niewidoczna dla innego domu.
 */
let script: Array<ProviderResponse['toolCalls']> = [];
const provider: FakeProvider = new FakeProvider({
  text: () => 'Gotowe.',
  get toolCalls(): ProviderResponse['toolCalls'] {
    return script[provider.calls.length - 1] ?? [];
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

let t: TestApp;
let alfa: Client;
let beta: Client;
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
  script = [];
});

const pantry = async (c: Client) =>
  Object.fromEntries(
    (await c.get('/api/pantry')).body.items.map((i: { name: string; status: string }) => [
      i.name,
      i.status,
    ]),
  ) as Record<string, string>;
/** Cofnięcie daty zakupu (symulacja upływu czasu). */
const age = (name: string, days: number) =>
  t.db.owner.query(
    `UPDATE pantry_items SET stocked_at = now() - make_interval(days => $2) WHERE name = $1`,
    [name, days],
  );

describe('spiżarnia', () => {
  it('nazwy, odmiana, typowa trwałość i stan', () => {
    expect(productName('jajka 5 szt.')).toBe('jajka');
    expect(productName('3 średnie cebule - 350 g')).toBe('cebule');
    expect(productName('papryki: 2 żółte, 2 czerwone')).toBe('papryki');
    expect(productName('Mleko 1 l')).toBe('mleko');
    expect(nameKey('cebula')).toBe(nameKey('cebule'));
    expect(nameKey('jajka')).toBe(nameKey('jajko'));
    expect(nameKey('cukier')).not.toBe(nameKey('cukinia'));
    expect(defaultsFor('chleb')).toEqual({ place: 'szafka', days: 3 });
    expect(defaultsFor('pierś z kurczaka')).toEqual({ place: 'lodowka', days: 3 });
    expect(defaultsFor('mąka pszenna')).toEqual({ place: 'szafka', days: 180 });
    expect(defaultsFor('papryka słodka')).toEqual({ place: 'szafka', days: 180 });
    expect(defaultsFor('mrożony szpinak')).toEqual({ place: 'zamrazarka', days: 90 });
    expect(defaultsFor('coś nowego')).toEqual({ place: 'lodowka', days: 7 });
    expect([statusOf(1, 6), statusOf(5, 6), statusOf(7, 6)]).toEqual([
      'masz',
      'konczy_sie',
      'raczej_nie',
    ]);
  });

  it('stan z upływu czasu; wspólna dla domu, niewidoczna dla innego domu; „jest” i „skończyło się”', async () => {
    expect(
      (await alfa.post('/api/pantry', { items: ['mleko', 'chleb', 'mąka pszenna'] })).status,
    ).toBe(201);
    await age('mleko', 5);
    await age('chleb', 4);
    await age('mąka pszenna', 30);
    expect(await pantry(beta)).toEqual({
      'mąka pszenna': 'masz',
      mleko: 'konczy_sie',
      chleb: 'raczej_nie',
    });
    const other = await createHousehold(t.db, 'Inny dom', [
      { email: 'gamma@example.test', displayName: 'Gamma' },
    ]);
    const seen = await withUserTx(t.db, { userId: other.userIds[0]!, scope: 'user' }, (c) =>
      listPantry(c, t.seed.householdId, other.userIds[0]!),
    );
    expect(seen).toEqual([]);

    const items = (await beta.get('/api/pantry')).body.items as Array<{ id: string; name: string }>;
    const id = (n: string) => items.find((i) => i.name === n)!.id;
    await beta.post(`/api/pantry/${id('chleb')}/have`);
    await beta.post(`/api/pantry/${id('mleko')}/gone`);
    expect(await pantry(alfa)).toEqual({ 'mąka pszenna': 'masz', chleb: 'masz' });
  });

  it('zakupy: odhaczone → spiżarnia (cofnięcie — z powrotem); trwałość uczy się z tempa zużycia', async () => {
    await alfa.post('/api/shopping', { items: ['jajka 10 szt.', 'mleko 1 l'] });
    const list = (await alfa.get('/api/shopping')).body.items as Array<{
      id: string;
      text: string;
    }>;
    const eggs = list.find((i) => i.text.startsWith('jajka'))!.id;
    const milk = list.find((i) => i.text.startsWith('mleko'))!.id;
    await beta.patch(`/api/shopping/${eggs}`, { checked: true });
    await beta.patch(`/api/shopping/${milk}`, { checked: true });
    expect(await pantry(alfa)).toEqual({ jajka: 'masz', mleko: 'masz' });
    await beta.patch(`/api/shopping/${eggs}`, { checked: false });
    expect(await pantry(alfa)).toEqual({ mleko: 'masz' });

    // Mleko skończyło się po 2 dniach (typowo 6) → kolejny zakup: trwałość (6 + 2) / 2 = 4.
    await age('mleko', 2);
    const row = (await alfa.get('/api/pantry')).body.items[0];
    await alfa.post(`/api/pantry/${row.id}/gone`);
    await alfa.post('/api/shopping', { items: ['mleko'] });
    const again = (await alfa.get('/api/shopping')).body.items.find(
      (i: { text: string; checked: boolean }) => i.text === 'mleko' && !i.checked,
    );
    await alfa.patch(`/api/shopping/${again.id}`, { checked: true });
    expect((await alfa.get('/api/pantry')).body.items[0]).toMatchObject({
      name: 'mleko',
      shelfDays: 4,
      status: 'masz',
    });
  });

  it('„pewnie masz” na liście: „Mam” → spiżarnia, „Kup” → do kupienia; inny przepis przenosi do kupienia', async () => {
    await withUserTx(t.db, { userId: t.seed.users.alfa, scope: 'user' }, async (c) => {
      const { addItems } = await import('../shopping/service');
      await addItems(
        c,
        t.seed.householdId,
        t.seed.users.alfa,
        ['cebula', 'czosnek', 'masło'],
        true,
      );
      await addItems(c, t.seed.householdId, t.seed.users.alfa, ['masło 200 g', 'masło']);
    });
    const items = (await beta.get('/api/shopping')).body.items as Array<{
      id: string;
      text: string;
      maybe: boolean;
    }>;
    expect(items.map((i) => [i.text, i.maybe])).toEqual([
      ['masło', false],
      ['masło 200 g', false],
      ['cebula', true],
      ['czosnek', true],
    ]);
    await beta.post(`/api/shopping/${items.find((i) => i.text === 'cebula')!.id}/have`);
    await beta.patch(`/api/shopping/${items.find((i) => i.text === 'czosnek')!.id}`, {
      maybe: false,
    });
    const after = (await alfa.get('/api/shopping')).body.items as Array<{
      text: string;
      maybe: boolean;
    }>;
    // „masło” i „czosnek” dodane jednym poleceniem — kolejność między nimi dowolna.
    expect(after.map((i) => `${i.text}:${i.maybe}`).sort()).toEqual([
      'czosnek:false',
      'masło 200 g:false',
      'masło:false',
    ]);
    expect(await pantry(alfa)).toEqual({ cebula: 'masz' });
  });

  it('danie: składniki zużyte po 3 dniach albo gdy ugotowane; wieczorem „pewnie skończyło się”', async () => {
    await alfa.post('/api/pantry', { items: ['papryka', 'kiełbasa', 'mąka', 'chleb'] });
    await withUserTx(t.db, { userId: t.seed.users.alfa, scope: 'user' }, (c) =>
      planMeal(c, t.seed.householdId, 'Leczo', ['papryka', 'kiełbasa']),
    );
    expect(Object.keys(await pantry(alfa)).sort()).toEqual([
      'chleb',
      'kiełbasa',
      'mąka',
      'papryka',
    ]);
    await t.db.owner.query(`UPDATE meals SET planned_at = now() - interval '4 days'`);
    expect(Object.keys(await pantry(alfa)).sort()).toEqual(['chleb', 'mąka']);

    await age('chleb', 5);
    const digest = await buildDigest(
      t.deps,
      { userId: t.seed.users.alfa, householdId: t.seed.householdId, displayName: 'Alfa (test)' },
      'evening',
    );
    expect(digest.body).toContain('Pewnie skończyło się: chleb');
  });

  it('asystent: spiżarnia w kontekście; „zrobiłem leczo”, „skończyło się mleko” — pantry.update', async () => {
    await alfa.post('/api/pantry', { items: ['mleko', 'papryka'] });
    await withUserTx(t.db, { userId: t.seed.users.alfa, scope: 'user' }, (c) =>
      planMeal(c, t.seed.householdId, 'Leczo', ['papryka']),
    );
    script = [[{ name: 'pantry.update', input: { gone: ['mleko'], cooked: 'leczo' } }]];
    const conv = (await alfa.post('/api/conversations', { space: 'private' })).body;
    await alfa.post(`/api/conversations/${conv.id}/messages`, {
      content: 'zrobiłem leczo, mleko się skończyło',
    });
    await t.drain();
    const system = provider.calls[0]!.system;
    expect(system).toContain('SPIŻARNIA (szacunek');
    expect(system).toContain('- masz: mleko (lodówka, 0 dni), papryka (lodówka, 0 dni)');
    expect(system).toContain('Nie pytaj użytkownika, czy coś ma');
    const msgs = (await alfa.get(`/api/conversations/${conv.id}/messages`)).body.items;
    expect(msgs.find((m: { role: string }) => m.role === 'tool').content).toBe(
      'Spiżarnia: skończyło się: mleko; ugotowane: Leczo (składniki zużyte)',
    );
    expect(await pantry(alfa)).toEqual({});
  });
});
