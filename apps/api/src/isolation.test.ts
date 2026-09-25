import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withUserTx } from './db/pool';
import { createTestApp, login, truncateAll, type Client, type TestApp } from './test/helpers';
import { seedDev } from './db/seed';

/**
 * M1 — testy przekrojowe dwóch użytkowników i trzech kontekstów agentów.
 * Każdy test sprawdza zarówno warstwę API (polityka), jak i efekt w bazie.
 */
let t: TestApp;
let alfa: Client;
let beta: Client;

const SECRET_ALFA = 'Alfa ukrywa prezent: zegarek w szafie';
const SECRET_BETA = 'Beta planuje wyjazd niespodziankę do Gdańska';

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

async function newConversation(c: Client, space: 'private' | 'shared', title = 'Test') {
  const r = await c.post('/api/conversations', { space, title });
  expect(r.status).toBe(201);
  return r.body as { id: string; agent: { kind: string } };
}

async function newMemory(c: Client, content: string, space: 'private' | 'shared' = 'private') {
  const r = await c.post('/api/memories', { content, space });
  expect(r.status).toBe(201);
  return r.body as { id: string; visibility: string };
}

async function lastAuditDeny(actorUserId: string) {
  const { rows } = await t.db.owner.query(
    `SELECT * FROM audit_log WHERE actor_user_id = $1 AND outcome = 'deny' ORDER BY id DESC LIMIT 1`,
    [actorUserId],
  );
  return rows[0];
}

describe('uwierzytelnienie i CSRF', () => {
  it('bez sesji => 401', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/me' });
    expect(r.statusCode).toBe(401);
  });
  it('mutacja bez nagłówka CSRF => 403', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/memories',
      headers: { cookie: alfa.cookie },
      payload: { content: 'x' },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('csrf');
  });
  it('mutacja z obcego Origin => 403', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/memories',
      headers: { cookie: alfa.cookie, 'x-nova-csrf': '1', origin: 'https://evil.example' },
      payload: { content: 'x' },
    });
    expect(r.statusCode).toBe(403);
  });
  it('/me zwraca tożsamość z sesji, 3 konteksty agentów widoczne właściwie', async () => {
    const me = await alfa.get('/api/me');
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(t.seed.users.alfa);
    expect(me.body.household.members).toHaveLength(2);
    const kinds = me.body.agents
      .map((a: { kind: string; name: string }) => `${a.kind}:${a.name}`)
      .sort();
    expect(kinds).toEqual(['household:NovaAI', 'private:Asystent Alfy']);
  });
  it('wylogowanie unieważnia sesję po stronie serwera', async () => {
    expect((await alfa.post('/api/auth/logout')).status).toBe(200);
    expect((await alfa.get('/api/me')).status).toBe(401);
  });
});

describe('rozmowy: Alfa i Beta nie czytają swoich prywatnych danych', () => {
  it('Beta nie czyta prywatnej rozmowy Alfy (404 + audyt bez treści)', async () => {
    const conv = await newConversation(alfa, 'private');
    expect(
      (await alfa.post(`/api/conversations/${conv.id}/messages`, { content: SECRET_ALFA })).status,
    ).toBe(201);

    expect((await beta.get(`/api/conversations/${conv.id}`)).status).toBe(404);
    expect((await beta.get(`/api/conversations/${conv.id}/messages`)).status).toBe(404);
    expect(
      (await beta.post(`/api/conversations/${conv.id}/messages`, { content: 'wtargnięcie' }))
        .status,
    ).toBe(404);

    const deny = await lastAuditDeny(t.seed.users.beta);
    expect(deny).toMatchObject({
      owner_user_id: t.seed.users.alfa,
      resource_id: conv.id,
      outcome: 'deny',
    });
    expect(JSON.stringify(deny)).not.toContain('zegarek');

    const list = await beta.get('/api/conversations?space=private');
    expect(list.body.items).toHaveLength(0);
  });

  it('Alfa nie czyta prywatnej rozmowy Bety', async () => {
    const conv = await newConversation(beta, 'private');
    await beta.post(`/api/conversations/${conv.id}/messages`, { content: SECRET_BETA });
    expect((await alfa.get(`/api/conversations/${conv.id}/messages`)).status).toBe(404);
    const msgs = await beta.get(`/api/conversations/${conv.id}/messages`);
    expect(msgs.body.items.map((m: { content: string }) => m.content)).toContain(SECRET_BETA);
  });

  it('rozmowa wspólna jest widoczna i zapisywalna dla obojga, agentem jest NovaAI', async () => {
    const conv = await newConversation(alfa, 'shared', 'Zakupy');
    expect(conv.agent.kind).toBe('household');
    expect(
      (await beta.post(`/api/conversations/${conv.id}/messages`, { content: 'mleko' })).status,
    ).toBe(201);
    const list = await beta.get('/api/conversations?space=shared');
    expect(list.body.items.map((c: { id: string }) => c.id)).toContain(conv.id);
    const msgs = await alfa.get(`/api/conversations/${conv.id}/messages`);
    expect(
      msgs.body.items.some(
        (m: { content: string; authorName: string }) =>
          m.content === 'mleko' && m.authorName === 'Beta (test)',
      ),
    ).toBe(true);
  });

  it('nieprawidłowy identyfikator => 404, nie 500', async () => {
    expect((await alfa.get('/api/conversations/not-a-uuid')).status).toBe(404);
    expect((await alfa.get('/api/conversations/00000000-0000-0000-0000-000000000000')).status).toBe(
      404,
    );
  });

  it('stronicowanie wiadomości działa kursorem', async () => {
    const conv = await newConversation(alfa, 'private');
    for (let i = 0; i < 3; i++) {
      await alfa.post(`/api/conversations/${conv.id}/messages`, { content: `m${i}` });
      await t.drain();
    }
    // 3 wiadomości użytkownika + 3 odpowiedzi agenta
    const p1 = await alfa.get(`/api/conversations/${conv.id}/messages?limit=4`);
    expect(p1.body.items).toHaveLength(4);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await alfa.get(
      `/api/conversations/${conv.id}/messages?limit=4&cursor=${p1.body.nextCursor}`,
    );
    expect(p2.body.items).toHaveLength(2);
    expect(p2.body.nextCursor).toBeNull();
    expect(p2.body.items[0].content).toBe('m0');
  });
});

describe('pamięć i jawne udostępnianie', () => {
  it('prywatna pamięć Alfy jest niewidoczna dla Bety w żadnej liście i nie da się jej zmienić', async () => {
    const m = await newMemory(alfa, SECRET_ALFA);
    const bPriv = await beta.get('/api/memories?space=private');
    const bShared = await beta.get('/api/memories?space=shared');
    expect(JSON.stringify([bPriv.body, bShared.body])).not.toContain('zegarek');
    expect((await beta.patch(`/api/memories/${m.id}`, { content: 'nadpisane' })).status).toBe(404);
    expect((await beta.del(`/api/memories/${m.id}`)).status).toBe(404);
    expect((await beta.post(`/api/memories/${m.id}/share`)).status).toBe(404);
    const row = await t.db.owner.query('SELECT content, visibility FROM memories WHERE id = $1', [
      m.id,
    ]);
    expect(row.rows[0]).toEqual({ content: SECRET_ALFA, visibility: 'private' });
  });

  it('udostępnienie jest jawne i audytowane; cofnięcie działa natychmiast', async () => {
    const m = await newMemory(alfa, 'Klucz zapasowy jest u sąsiadów');
    const shared = await alfa.post(`/api/memories/${m.id}/share`);
    expect(shared.status).toBe(200);
    expect(shared.body.visibility).toBe('shared');

    let bShared = await beta.get('/api/memories?space=shared');
    expect(bShared.body.items.map((x: { id: string }) => x.id)).toContain(m.id);
    expect(bShared.body.items.find((x: { id: string }) => x.id === m.id).isMine).toBe(false);

    // Beta widzi, ale nie zarządza cudzą pamięcią.
    expect((await beta.post(`/api/memories/${m.id}/unshare`)).status).toBe(403);
    expect((await beta.patch(`/api/memories/${m.id}`, { content: 'x' })).status).toBe(403);

    expect((await alfa.post(`/api/memories/${m.id}/unshare`)).status).toBe(200);
    bShared = await beta.get('/api/memories?space=shared');
    expect(bShared.body.items).toHaveLength(0);

    const audit = await t.db.owner.query(
      `SELECT action FROM audit_log WHERE resource_id = $1 AND outcome = 'ok' ORDER BY id`,
      [m.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'memory.create',
      'memory.share',
      'memory.unshare',
    ]);
    const grants = await t.db.owner.query(
      'SELECT revoked_at FROM memory_grants WHERE memory_id = $1',
      [m.id],
    );
    expect(grants.rows).toHaveLength(1);
    expect(grants.rows[0].revoked_at).not.toBeNull();
    // Odwracalność: ponowne udostępnienie tworzy nowy grant.
    expect((await alfa.post(`/api/memories/${m.id}/share`)).status).toBe(200);
  });

  it('klient nie może wskazać właściciela: ownerUserId w payloadzie jest ignorowany', async () => {
    const r = await beta.post('/api/memories', { content: 'moje', ownerUserId: t.seed.users.alfa });
    expect(r.status).toBe(201);
    expect(r.body.ownerUserId).toBe(t.seed.users.beta);
  });

  it('wspólna pamięć z visibility=shared, ale bez aktywnego grantu nie jest widoczna (defense in depth)', async () => {
    const m = await newMemory(alfa, 'niespójny rekord');
    await t.db.owner.query(`UPDATE memories SET visibility = 'shared' WHERE id = $1`, [m.id]);
    const bShared = await beta.get('/api/memories?space=shared');
    expect(bShared.body.items).toHaveLength(0);
  });
});

describe('konteksty agentów: prywatny, prywatny, NovaAI', () => {
  async function ask(c: Client, convId: string, content = 'co pamiętasz?') {
    const r = await c.post(`/api/conversations/${convId}/messages`, { content });
    expect(r.status).toBe(201);
    expect(r.body.taskId).toBeTruthy();
    await t.drain();
    const msgs = await c.get(`/api/conversations/${convId}/messages?limit=100`);
    const last = msgs.body.items[msgs.body.items.length - 1];
    expect(last.role).toBe('assistant');
    return last as { content: string; meta: Record<string, unknown> };
  }

  it('agent prywatny Alfy widzi jej prywatne + wspólne, nigdy prywatnych Bety', async () => {
    await newMemory(alfa, SECRET_ALFA);
    await newMemory(beta, SECRET_BETA);
    await newMemory(beta, 'Wspólne: rachunek za prąd w piątek', 'shared');
    const conv = await newConversation(alfa, 'private');
    const reply = await ask(alfa, conv.id);
    expect(reply.content).toContain('zegarek');
    expect(reply.content).toContain('rachunek za prąd');
    expect(reply.content).not.toContain('Gdańsk');
    expect(reply.meta.demo).toBe(true);
  });

  it('agent prywatny Bety nie widzi prywatnych danych Alfy', async () => {
    await newMemory(alfa, SECRET_ALFA);
    const conv = await newConversation(beta, 'private');
    const reply = await ask(beta, conv.id);
    expect(reply.content).not.toContain('zegarek');
  });

  it('NovaAI widzi tylko jawnie wspólne dane — także gdy pyta właściciel prywatnych danych', async () => {
    await newMemory(alfa, SECRET_ALFA);
    const shared = await newMemory(alfa, 'Wspólne: urodziny babci 12 października', 'shared');
    const conv = await newConversation(alfa, 'shared');
    let reply = await ask(alfa, conv.id);
    expect(reply.content).toContain('urodziny babci');
    expect(reply.content).not.toContain('zegarek');

    // Cofnięcie udostępnienia działa od następnej tury.
    await alfa.post(`/api/memories/${shared.id}/unshare`);
    reply = await ask(beta, conv.id);
    expect(reply.content).not.toContain('urodziny babci');
  });

  it('historia prywatnej rozmowy nie trafia do NovaAI', async () => {
    const priv = await newConversation(alfa, 'private');
    await alfa.post(`/api/conversations/${priv.id}/messages`, { content: SECRET_ALFA });
    const conv = await newConversation(beta, 'shared');
    const reply = await ask(beta, conv.id, 'zegarek?');
    expect(reply.content).not.toContain('szafie');
  });
});

describe('członkostwo', () => {
  it('odebranie członkostwa natychmiast odcina dane wspólne', async () => {
    const conv = await newConversation(alfa, 'shared');
    await newMemory(alfa, 'wspólna notatka', 'shared');
    expect((await beta.get(`/api/conversations/${conv.id}`)).status).toBe(200);

    await t.db.owner.query(
      `UPDATE memberships SET status = 'revoked', revoked_at = now() WHERE user_id = $1`,
      [t.seed.users.beta],
    );
    expect((await beta.get(`/api/conversations/${conv.id}`)).status).toBe(404);
    const mem = await beta.get('/api/memories?space=shared');
    expect(mem.body.items).toHaveLength(0);
    expect((await beta.post('/api/conversations', { space: 'shared' })).status).toBe(403);
  });
});

describe('RLS — druga warstwa działa niezależnie od kodu aplikacji', () => {
  it('zapytanie bez WHERE jako Beta nie zwraca prywatnych danych Alfy', async () => {
    const conv = await newConversation(alfa, 'private');
    await alfa.post(`/api/conversations/${conv.id}/messages`, { content: SECRET_ALFA });
    await newMemory(alfa, SECRET_ALFA);
    await newMemory(beta, SECRET_BETA);

    const seen = await withUserTx(t.db, { userId: t.seed.users.beta, scope: 'user' }, async (c) => {
      const m = await c.query('SELECT content FROM memories');
      const msg = await c.query('SELECT content FROM messages');
      const cv = await c.query('SELECT id FROM conversations');
      return { m: m.rows, msg: msg.rows, cv: cv.rows };
    });
    expect(seen.m.map((r) => r.content)).toEqual([SECRET_BETA]);
    expect(seen.msg).toHaveLength(0);
    expect(seen.cv).toHaveLength(0);
  });

  it('scope=shared (NovaAI) nie widzi prywatnych danych nawet samego właściciela', async () => {
    await newMemory(alfa, SECRET_ALFA);
    await newMemory(alfa, 'wspólne', 'shared');
    const rows = await withUserTx(
      t.db,
      { userId: t.seed.users.alfa, scope: 'shared' },
      async (c) => (await c.query('SELECT content FROM memories')).rows,
    );
    expect(rows.map((r) => r.content)).toEqual(['wspólne']);
  });

  it('bez kontekstu sesji rola aplikacji nie widzi nic', async () => {
    await newMemory(alfa, SECRET_ALFA);
    const r = await t.db.app.query('SELECT count(*)::int AS n FROM memories');
    expect(r.rows[0].n).toBe(0);
  });

  it('RLS blokuje zapis w imieniu innego użytkownika i modyfikację cudzych rekordów', async () => {
    const m = await newMemory(alfa, SECRET_ALFA);
    await expect(
      withUserTx(t.db, { userId: t.seed.users.beta, scope: 'user' }, (c) =>
        c.query(
          `INSERT INTO memories (household_id, owner_user_id, kind, content) VALUES ($1, $2, 'profile', 'x')`,
          [t.seed.householdId, t.seed.users.alfa],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const upd = await withUserTx(t.db, { userId: t.seed.users.beta, scope: 'user' }, (c) =>
      c.query(`UPDATE memories SET content = 'x' WHERE id = $1`, [m.id]),
    );
    expect(upd.rowCount).toBe(0);
    const del = await withUserTx(t.db, { userId: t.seed.users.beta, scope: 'user' }, (c) =>
      c.query(`DELETE FROM memories WHERE id = $1`, [m.id]),
    );
    expect(del.rowCount).toBe(0);
  });

  it('rola aplikacji nie ma dostępu do sesji ani zapisu audytu', async () => {
    await expect(t.db.app.query('SELECT * FROM auth_sessions')).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      withUserTx(t.db, { userId: t.seed.users.alfa, scope: 'user' }, (c) =>
        c.query(
          `INSERT INTO audit_log (actor_kind, source, action, outcome) VALUES ('user','api','x','ok')`,
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('trigger bazy wymusza właściwego agenta dla rozmowy prywatnej', async () => {
    await expect(
      withUserTx(t.db, { userId: t.seed.users.alfa, scope: 'user' }, (c) =>
        c.query(
          `INSERT INTO conversations (household_id, owner_user_id, agent_id, visibility, title)
           VALUES ($1, $2, $3, 'private', 'x')`,
          [t.seed.householdId, t.seed.users.alfa, t.seed.agents.beta],
        ),
      ),
    ).rejects.toThrow(/private agent/);
  });
});
