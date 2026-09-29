import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHousehold } from '../db/admin';
import { withUserTx } from '../db/pool';
import { seedDev } from '../db/seed';
import { buildDigest } from '../digest/service';
import { createTestApp, login, truncateAll, type Client, type TestApp } from '../test/helpers';
import { addItems, listItems, shortList } from './service';

/** Wspólna lista zakupów: domownicy razem, bez powtórzeń, odhaczanie, zdarzenie na żywo, izolacja domów. */
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

const texts = async (c: Client) =>
  (await c.get('/api/shopping')).body.items.map((i: { text: string; checked: boolean }) =>
    i.checked ? `✓ ${i.text}` : i.text,
  );

describe('lista zakupów', () => {
  it('wspólna: dodawanie bez powtórzeń, odhaczanie przez domownika, usuwanie kupionych', async () => {
    const add = await alfa.post('/api/shopping', {
      items: ['mleko', ' Jajka  10 szt ', 'MLEKO', ''],
    });
    expect(add.status).toBe(201);
    expect(add.body).toEqual({ added: ['mleko', 'Jajka 10 szt'], skipped: ['MLEKO'] });
    expect(await texts(beta)).toEqual(['mleko', 'Jajka 10 szt']);

    const items = (await beta.get('/api/shopping')).body.items;
    const milk = items.find((i: { text: string }) => i.text === 'mleko');
    expect(milk.addedBy).toBe(t.seed.users.alfa);
    expect((await beta.patch(`/api/shopping/${milk.id}`, { checked: true })).status).toBe(200);
    expect(await texts(alfa)).toEqual(['Jajka 10 szt', '✓ mleko']);
    // Kupione „mleko” można dodać ponownie (nowa pozycja do kupienia).
    expect((await alfa.post('/api/shopping', { items: ['mleko'] })).body.added).toEqual(['mleko']);

    expect((await alfa.post('/api/shopping/clear-checked')).body.removed).toBe(1);
    expect(await texts(alfa)).toEqual(['Jajka 10 szt', 'mleko']);
    const eggs = (await alfa.get('/api/shopping')).body.items[0];
    expect((await beta.del(`/api/shopping/${eggs.id}`)).status).toBe(204);
    expect(await texts(alfa)).toEqual(['mleko']);

    const ev = await t.db.owner.query(
      `SELECT visibility, count(*)::int AS n FROM events WHERE type = 'shopping.changed' GROUP BY visibility`,
    );
    expect(ev.rows).toEqual([{ visibility: 'shared', n: 5 }]);
  });

  it('inny dom nie widzi i nie dopisuje do listy', async () => {
    await alfa.post('/api/shopping', { items: ['chleb'] });
    const other = await createHousehold(t.db, 'Inny dom', [
      { email: 'gamma@example.test', displayName: 'Gamma' },
    ]);
    const gamma = other.userIds[0]!;
    const seen = await withUserTx(t.db, { userId: gamma, scope: 'user' }, (c) =>
      listItems(c, t.seed.householdId),
    );
    expect(seen).toEqual([]);
    await expect(
      withUserTx(t.db, { userId: gamma, scope: 'user' }, (c) =>
        addItems(c, t.seed.householdId, gamma, ['włamanie']),
      ),
    ).rejects.toThrow();
    expect(await texts(alfa)).toEqual(['chleb']);
  });

  it('przegląd dnia pokazuje, co jest do kupienia', async () => {
    await beta.post('/api/shopping', { items: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
    const d = await buildDigest(
      t.deps,
      { userId: t.seed.users.alfa, householdId: t.seed.householdId, displayName: 'Alfa (test)' },
      'evening',
    );
    expect(d.body).toContain('Lista zakupów: a, b, c, d, e (+2)');
    expect(shortList(['x'])).toBe('x');
  });
});
