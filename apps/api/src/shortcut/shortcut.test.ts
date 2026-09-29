import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withUserTx } from '../db/pool';
import { seedDev } from '../db/seed';
import { ModelAgentRuntime } from '../model/agent-runtime';
import { createConversation } from '../modules/conversations';
import { createTask } from '../queue/tasks';
import { createTestApp, login, truncateAll, type Client, type TestApp } from '../test/helpers';
import { forSpeech, waitForReply } from './routes';

/** Skrót Siri: klucz pokazywany raz, pytanie bez ciasteczka → odpowiedź tekstem, prywatna rozmowa „Siri”. */
let t: TestApp;
let alfa: Client;
let beta: Client;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());
beforeEach(async () => {
  await truncateAll(t.db);
  t.seed = await seedDev(t.db, 'test');
  alfa = await login(t.app, 'alfa');
  beta = await login(t.app, 'beta');
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pytanie tak, jak wysyła je aplikacja Skróty: bez ciasteczka i bez nagłówka CSRF. Kolejka opróżniana w tle. */
async function ask(key: string | null, payload: unknown) {
  let done = false;
  const res = t.app
    .inject({
      method: 'POST',
      url: '/api/shortcut/ask',
      headers: key ? { authorization: `Bearer ${key}` } : {},
      payload: payload as object,
    })
    .finally(() => {
      done = true;
    });
  while (!done) {
    await t.drain();
    await sleep(30);
  }
  return res;
}

describe('Skrót Siri', () => {
  it('klucz: widoczny raz (w bazie tylko skrót), nowy zastępuje stary, wyłączenie unieważnia', async () => {
    expect((await alfa.get('/api/shortcut')).body).toMatchObject({ enabled: false });
    const first = await alfa.post('/api/shortcut/key');
    expect(first.status).toBe(201);
    expect(first.body.key).toMatch(/^nova_siri_[A-Za-z0-9_-]{43}$/);
    expect(first.body.url).toMatch(/\/api\/shortcut\/ask$/);
    const stored = await t.db.owner.query(
      `SELECT 1 FROM shortcut_keys WHERE encode(key_hash, 'escape') LIKE '%' || $1 || '%'`,
      [first.body.key],
    );
    expect(stored.rowCount).toBe(0);
    expect((await alfa.get('/api/shortcut')).body).toMatchObject({
      enabled: true,
      lastUsedAt: null,
    });
    // Klucza nie da się odczytać ponownie ani utworzyć bez nagłówka CSRF.
    expect(JSON.stringify((await alfa.get('/api/shortcut')).body)).not.toContain(first.body.key);
    const csrf = await t.app.inject({
      method: 'POST',
      url: '/api/shortcut/key',
      headers: { cookie: alfa.cookie },
    });
    expect(csrf.statusCode).toBe(403);

    const second = (await alfa.post('/api/shortcut/key')).body.key;
    expect((await ask(first.body.key, { question: 'hej' })).statusCode).toBe(401);
    expect((await ask(second, { question: 'hej' })).statusCode).toBe(200);
    expect((await alfa.del('/api/shortcut/key')).status).toBe(204);
    const off = await ask(second, { question: 'hej' });
    expect(off.statusCode).toBe(401);
    expect(off.headers['content-type']).toMatch(/^text\/plain/);
    expect(off.body).toContain('Ustawienia, Skrót Siri');
  });

  it('pytanie: odpowiedź tekstem w prywatnej rozmowie „Siri” (ta sama przy kolejnych), domownik jej nie widzi', async () => {
    const key = (await alfa.post('/api/shortcut/key')).body.key;
    const res = await ask(key, { question: 'Co mam dziś?' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.body).toContain('Otrzymałem: „Co mam dziś?”');
    expect((await ask(key, { question: 'A jutro?' })).body).toContain('A jutro?');

    const convs = (await alfa.get('/api/conversations?space=private')).body.items;
    const siri = convs.filter((c: { title: string }) => c.title === 'Siri');
    expect(siri).toHaveLength(1);
    expect(siri[0].visibility).toBe('private');
    const msgs = (await alfa.get(`/api/conversations/${siri[0].id}/messages`)).body.items;
    expect(msgs.map((m: { role: string }) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(msgs[0].meta).toEqual({ via: 'siri' });
    // Kontekst drugiej tury zawiera pierwsze pytanie (rozmowa ciągła).
    expect(msgs[3].content).toContain('kontekst: 2 wiad.');
    expect((await beta.get(`/api/conversations/${siri[0].id}`)).status).toBe(404);
    expect((await alfa.get('/api/shortcut')).body.lastUsedAt).not.toBeNull();

    // Zarchiwizowana rozmowa — następne pytanie zaczyna nową.
    await t.db.owner.query('UPDATE conversations SET archived_at = now() WHERE id = $1', [
      siri[0].id,
    ]);
    await ask(key, { question: 'Nowa rozmowa?' });
    const after = (await alfa.get('/api/conversations?space=private')).body.items;
    expect(after.filter((c: { title: string }) => c.title === 'Siri')).toHaveLength(1);
    expect(after[0].id).not.toBe(siri[0].id);
  });

  it('akcja ze zgodą: odpowiedź mówi, że zgoda czeka w aplikacji; nic nie zapisane', async () => {
    const key = (await alfa.post('/api/shortcut/key')).body.key;
    const res = await ask(key, { question: 'zaproponuj zapamiętanie: nie jem glutenu' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Czy zapamiętać: „nie jem glutenu”?');
    expect(res.body).toContain('Zgoda czeka w aplikacji NovaAI.');
    expect((await alfa.get('/api/approvals?status=pending')).body.items).toHaveLength(1);
    expect((await alfa.get('/api/memories')).body.items).toHaveLength(0);
  });

  it('odmowy zwykłym tekstem: brak lub zły klucz, ciasteczko zamiast klucza, puste pytanie', async () => {
    const key = (await alfa.post('/api/shortcut/key')).body.key;
    expect((await ask(null, { question: 'hej' })).statusCode).toBe(401);
    expect((await ask('nova_siri_zly', { question: 'hej' })).statusCode).toBe(401);
    const cookieOnly = await t.app.inject({
      method: 'POST',
      url: '/api/shortcut/ask',
      headers: { cookie: alfa.cookie, 'x-nova-csrf': '1' },
      payload: { question: 'hej' },
    });
    expect(cookieOnly.statusCode).toBe(401);
    const empty = await ask(key, { question: '   ' });
    expect(empty.statusCode).toBe(400);
    expect(empty.headers['content-type']).toMatch(/^text\/plain/);
    const tasks = await t.db.owner.query('SELECT 1 FROM tasks');
    expect(tasks.rowCount).toBe(0);
  });

  it('bez odpowiedzi w czasie — „jeszcze pracuję”; tekst do mowy bez formatowania; podpowiedź dla modelu', async () => {
    const taskId = await withUserTx(
      t.db,
      { userId: t.seed.users.alfa, scope: 'user' },
      async (c) => {
        const conv = await createConversation(c, t.seed.householdId, 'private', 'Siri');
        return createTask(c, {
          householdId: t.seed.householdId,
          visibility: 'private',
          conversationId: conv.id,
          kind: 'agent.turn',
          title: 'test',
          steps: [{ key: 'reply', title: 'Odpowiedź', kind: 'model' }],
        });
      },
    );
    expect(await waitForReply(t.db, taskId, 300)).toEqual({ status: 'timeout' });

    expect(forSpeech('**Jutro** masz:\n- kolokwium z analizy [D1]\n- [plan](https://x.pl)')).toBe(
      'Jutro masz:\nkolokwium z analizy\nplan',
    );

    const runtime = new ModelAgentRuntime(t.deps.gateway, t.deps.broker);
    const ctx = {
      userId: t.seed.users.alfa,
      displayName: 'Alfa',
      householdId: t.seed.householdId,
      agentKind: 'private' as const,
      agentName: 'Nova',
      runtimeProfile: 'default',
    };
    const input = { conversationId: taskId, userMessage: 'x', history: [], memories: [] };
    expect(runtime.systemPrompt(ctx, { ...input, spoken: true })).toContain(
      'przeczyta na głos Siri',
    );
    expect(runtime.systemPrompt(ctx, input)).not.toContain('Siri');
  });
});
