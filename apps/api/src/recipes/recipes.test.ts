import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDev } from '../db/seed';
import { ModelsConfigSchema } from '../model/config';
import { FakeProvider } from '../model/providers/fake';
import type { ProviderResponse } from '../model/types';
import { createTestApp, login, truncateAll, type Client, type TestApp } from '../test/helpers';
import { isStaple, parseRecipe, parseSearch, slugFromUrl } from './aniagotuje';

/**
 * „Chcę zrobić leczo” → przepis z aniagotuje.pl (atrapa serwisu) → składniki → lista zakupów z sumą ilości
 * do zatwierdzenia. Znaczniki jak na prawdziwej stronie (schema.org Recipe, sprawdzone 2026-09-30).
 */
const LECZO = `<html><body><h1 class="t">Leczo</h1>
<article itemscope itemtype="https://schema.org/Recipe"><meta itemprop="recipeYield" content="1750 gramów leczo">
<ul class="recipe-ing-list">
<li><span itemprop="recipeIngredient" class="ingredient-text"><span class="ingredient ingredient-name">papryki: 2 żółte, 2 czerwone = 850 g</span><!----></span></li>
<li><span itemprop="recipeIngredient" class="ingredient-text"><span class="ingredient ingredient-name">3 średnie cebule - 350&nbsp;g</span></span></li>
<li><span itemprop="recipeIngredient" class="ingredient-text"><span class="ingredient ingredient-name">1 szklanka wody</span></span></li>
<li><span class="ingredient-text"><span class="ingredient ingredient-name">przyprawy: papryka, sól, pieprz</span></span>
<meta itemprop="recipeIngredient" content="płaska łyżka słodkiej papryki"><meta itemprop="recipeIngredient" content="1 płaska łyżeczka soli"><meta itemprop="recipeIngredient" content="1/4 łyżeczki pieprzu"></li>
</ul></article></body></html>`;
const SEARCH = `<div class="res-col-con"><article class="res-col"><div class="col-title"><a href="/przepis/leczo" data-v-1><h2 data-v-1>Leczo</h2></a> <a href="/przepis/leczo#comments-list">12</a></div></article>
<article class="res-col"><div class="col-title"><a href="/przepis/leczo-z-cukinia" data-v-1><h2 data-v-1>Leczo z cukinią</h2></a></div></article></div>`;

let site: Server;
let base: string;
const requested: string[] = [];
let t: TestApp;
let alfa: Client;
let beta: Client;
/** Wywołania narzędzi kolejnych odpowiedzi modelu: [0] — tura, [1] — tura uzupełniająca. */
let script: Array<ProviderResponse['toolCalls']> = [];
let texts: string[] = [];
const provider: FakeProvider = new FakeProvider({
  text: () => texts[provider.calls.length - 1] ?? 'Odpowiedź modelu.',
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

beforeAll(async () => {
  site = createServer((req, res) => {
    requested.push(req.url ?? '');
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/szukaj')
      return res.end(url.searchParams.get('s') === 'leczo' ? SEARCH : '');
    if (url.pathname === '/przepis/leczo') return res.end(LECZO);
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  t = await createTestApp(
    {},
    { modelsConfig, providerOverrides: { llm: provider }, recipeBase: base },
  );
});
afterAll(async () => {
  await t.close();
  site.close();
});
beforeEach(async () => {
  await truncateAll(t.db);
  t.seed = await seedDev(t.db, 'test');
  alfa = await login(t.app, 'alfa');
  beta = await login(t.app, 'beta');
  provider.calls = [];
  requested.length = 0;
  script = [];
  texts = [];
});

async function turn(c: Client, content: string) {
  const conv = (await c.post('/api/conversations', { space: 'private' })).body;
  await c.post(`/api/conversations/${conv.id}/messages`, { content });
  await t.drain();
  return (await c.get(`/api/conversations/${conv.id}/messages`)).body.items as Array<{
    role: string;
    content: string;
    meta: Record<string, any>;
  }>;
}
const open = async (c: Client) =>
  (await c.get('/api/shopping')).body.items
    .filter((i: { checked: boolean }) => !i.checked)
    .map((i: { text: string }) => i.text);

describe('przepisy z aniagotuje.pl', () => {
  it('składniki: tekst i rozbicie <meta>, encje; wyniki wyszukiwania; tylko linki aniagotuje.pl', () => {
    const r = parseRecipe(LECZO, 'leczo')!;
    expect(r.title).toBe('Leczo');
    expect(r.yield).toBe('1750 gramów leczo');
    expect(r.ingredients).toEqual([
      'papryki: 2 żółte, 2 czerwone = 850 g',
      '3 średnie cebule - 350 g',
      '1 szklanka wody',
      'płaska łyżka słodkiej papryki',
      '1 płaska łyżeczka soli',
      '1/4 łyżeczki pieprzu',
    ]);
    expect(r.ingredients.filter((i) => !isStaple(i))).toEqual([
      'papryki: 2 żółte, 2 czerwone = 850 g',
      '3 średnie cebule - 350 g',
      'płaska łyżka słodkiej papryki',
    ]);
    expect(isStaple('masło solone')).toBe(false);
    expect(parseRecipe('<h1>Blog</h1>', 'x')).toBeNull();
    expect(parseSearch(SEARCH)).toEqual([
      { slug: 'leczo', title: 'Leczo' },
      { slug: 'leczo-z-cukinia', title: 'Leczo z cukinią' },
    ]);
    expect(slugFromUrl('https://aniagotuje.pl/przepis/leczo')).toBe('leczo');
    expect(slugFromUrl('https://www.aniagotuje.pl/przepis/leczo/')).toBe('leczo');
    expect(slugFromUrl('https://evil.example/przepis/leczo')).toBeNull();
    expect(slugFromUrl('http://aniagotuje.pl/przepis/leczo')).toBeNull();
    expect(slugFromUrl('https://aniagotuje.pl/przepis/../admin')).toBeNull();
  });

  it('„chcę zrobić leczo”: przepis → lista z sumą ilości do zatwierdzenia → jedna wspólna lista', async () => {
    await beta.post('/api/shopping', { items: ['cebula 1 szt.', 'chleb'] });
    script = [
      [{ name: 'recipe.find', input: { dish: 'leczo' } }],
      [
        {
          name: 'shopping.add',
          input: {
            items: ['papryka 850 g', 'papryka słodka'],
            update: [{ from: 'cebula 1 szt.', to: 'cebula 4 szt.' }],
          },
        },
      ],
    ];
    texts = ['', 'Leczo z aniagotuje.pl: https://aniagotuje.pl/przepis/leczo — zatwierdź listę.'];
    const msgs = await turn(alfa, 'chcę zrobić leczo');

    // Tura: lista zakupów w kontekście, wskazówka o przepisach; pusty tekst → ukryta zapowiedź.
    const [reply, follow] = provider.calls;
    // Lista zakupów zmienia się często — na początku ostatniej wiadomości, nie w prompcie systemowym (cache).
    const turnText = reply!.messages.at(-1)!.content;
    expect(turnText).toContain('LISTA ZAKUPÓW (do kupienia, 2 poz.');
    expect(turnText).toContain('- cebula 1 szt.');
    expect(reply!.system).not.toContain('LISTA ZAKUPÓW (do kupienia');
    expect(reply!.system).toContain('aniagotuje.pl — główne źródło przepisów');
    expect(requested).toEqual(['/szukaj?s=leczo', '/przepis/leczo']);
    // Tura uzupełniająca: składniki bez wody, soli i pieprzu; jedyne narzędzie — lista zakupów.
    expect(follow!.tools.map((x: { name: string }) => x.name)).toEqual(['shopping.add']);
    const toolMsg = JSON.stringify(follow!.messages);
    // Lista zakupów także w turze uzupełniającej (po wynikach narzędzi) — do sumowania ilości.
    expect(follow!.messages.at(-1)!.content).toContain('- cebula 1 szt.');
    expect(toolMsg).toContain('3 średnie cebule - 350 g');
    expect(toolMsg).not.toContain('- 1 szklanka wody');
    expect(toolMsg).toContain('Pominięte (zwykle w domu)');

    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(msgs[1]!.meta).toMatchObject({ followUpExpected: true, interim: true });
    expect(msgs[1]!.content).not.toMatch(/recipe\.find|Proponuję/);
    expect(msgs[3]!.meta).toMatchObject({
      followUp: true,
      proposedTools: [{ tool: 'shopping.add', approval: true }],
    });

    // Zgoda z całą listą; do czasu zatwierdzenia lista bez zmian.
    const ap = (await alfa.get('/api/approvals?status=pending')).body.items[0];
    expect(ap.diff).toBe('+ papryka 850 g\n+ papryka słodka\n~ cebula 1 szt. → cebula 4 szt.');
    expect(await open(beta)).toEqual(['cebula 1 szt.', 'chleb']);
    await alfa.post(`/api/approvals/${ap.id}/approve`, { actionHash: ap.actionHash });
    await t.drain();
    expect(await open(beta)).toEqual(['cebula 4 szt.', 'chleb', 'papryka 850 g', 'papryka słodka']);
  });

  it('bez przepisu (np. lista zakupów) tura uzupełniająca nie dostaje narzędzi; zły link odrzucony', async () => {
    script = [
      [{ name: 'shopping.list', input: {} }],
      [{ name: 'memory.create', input: { content: 'x' } }],
    ];
    const msgs = await turn(alfa, 'co mamy kupić?');
    expect(provider.calls[1]!.tools).toEqual([]);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect((await alfa.get('/api/memories')).body.items).toHaveLength(0);

    provider.calls = [];
    script = [[{ name: 'recipe.find', input: { url: 'https://evil.example/przepis/leczo' } }]];
    const denied = await turn(alfa, 'dodaj składniki z tego linku');
    expect(denied[1]!.meta.deniedTools).toEqual([
      { tool: 'recipe.find', reason: 'not_aniagotuje_url' },
    ]);
    expect(requested).toEqual([]);
  });
});
