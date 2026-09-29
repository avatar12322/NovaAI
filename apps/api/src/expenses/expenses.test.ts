import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDev } from '../db/seed';
import { buildDigest, warsawClock } from '../digest/service';
import { createTestApp, login, truncateAll, type Client, type TestApp } from '../test/helpers';
import { dueDateIn, monthEnd, nextMonth } from './service';

/** Wydatki wspólne i prywatne, stałe płatności i raty („zapłacone” raz w miesiącu), przegląd dnia. */
let t: TestApp;
let alfa: Client;
let beta: Client;
const today = warsawClock(new Date()).date;
const month = today.slice(0, 7);

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

const expense = (c: Client, over: Record<string, unknown>) =>
  c.post('/api/expenses', {
    amount: 10,
    category: 'jedzenie',
    description: '',
    spentOn: today,
    space: 'shared',
    ...over,
  });

describe('wydatki', () => {
  it('wspólne widzą oboje, prywatne tylko autor; sumy i kategorie; usuwa tylko autor', async () => {
    await expense(alfa, { amount: 45.2, description: 'Biedronka', space: 'shared' });
    await expense(beta, { amount: 120, category: 'dom', description: 'Farba', space: 'shared' });
    await expense(alfa, { amount: 450, category: 'raty', description: 'Rata', space: 'private' });
    const secret = await expense(beta, { amount: 99, description: 'Prezent', space: 'private' });

    const a = (await alfa.get(`/api/expenses?month=${month}`)).body;
    expect(a.items.map((e: { description: string }) => e.description).sort()).toEqual([
      'Biedronka',
      'Farba',
      'Rata',
    ]);
    expect(a.totals).toEqual([{ currency: 'PLN', total: 615.2 }]);
    expect(a.byCategory[0]).toEqual({ category: 'raty', currency: 'PLN', total: 450 });
    const shared = (await beta.get(`/api/expenses?month=${month}&space=shared`)).body;
    expect(shared.totals).toEqual([{ currency: 'PLN', total: 165.2 }]);

    expect((await alfa.del(`/api/expenses/${secret.body.expense.id}`)).status).toBe(404);
    expect((await beta.del(`/api/expenses/${secret.body.expense.id}`)).status).toBe(204);
    const future = new Date(`${today}T12:00:00Z`);
    future.setUTCDate(future.getUTCDate() + 2);
    expect((await expense(alfa, { spentOn: future.toISOString().slice(0, 10) })).status).toBe(400);
    expect((await expense(alfa, { amount: -5 })).status).toBe(400);
    expect((await expense(alfa, { category: 'zakazana' })).status).toBe(400);
  });

  it('raty: termin w miesiącu, ile zostało, „zapłacone” raz; prywatne niewidoczne dla domownika', async () => {
    const last = nextMonth(nextMonth(month));
    const rata = await alfa.post('/api/payments', {
      name: 'Rata za telefon',
      amount: 120,
      dayOfMonth: 31,
      lastMonth: last,
      space: 'private',
    });
    expect(rata.status).toBe(201);
    const rent = await beta.post('/api/payments', {
      name: 'Czynsz',
      amount: 2000,
      dayOfMonth: 31,
      space: 'shared',
    });

    const list = (await alfa.get('/api/payments')).body.items;
    const phone = list.find((p: { name: string }) => p.name === 'Rata za telefon');
    expect(phone).toMatchObject({
      dueDate: dueDateIn(month, 31),
      paid: false,
      remaining: 3,
      visibility: 'private',
    });
    expect(list.find((p: { name: string }) => p.name === 'Czynsz').remaining).toBeNull();
    expect((await beta.get('/api/payments')).body.items.map((p: any) => p.name)).toEqual([
      'Czynsz',
    ]);
    expect((await beta.post(`/api/payments/${rata.body.id}/paid`)).status).toBe(404);

    const paid = await alfa.post(`/api/payments/${rata.body.id}/paid`);
    expect(paid.body).toMatchObject({ paid: true, already: false });
    expect(paid.body.expense).toMatchObject({
      amount: 120,
      category: 'raty',
      visibility: 'private',
    });
    expect((await alfa.post(`/api/payments/${rata.body.id}/paid`)).body.already).toBe(true);
    const after = (await alfa.get('/api/payments')).body.items.find(
      (p: { id: string }) => p.id === rata.body.id,
    );
    expect(after).toMatchObject({ paid: true, remaining: 2 });

    // Wspólny czynsz opłacony przez Alfę — wydatek wspólny widoczny dla Bety.
    await alfa.post(`/api/payments/${rent.body.id}/paid`);
    const betaExp = (await beta.get(`/api/expenses?month=${month}`)).body.items;
    expect(betaExp.map((e: { description: string }) => e.description)).toEqual(['Czynsz']);

    // Zakończenie tylko przez autora.
    expect((await beta.del(`/api/payments/${rata.body.id}`)).status).toBe(404);
    expect((await alfa.del(`/api/payments/${rata.body.id}`)).status).toBe(204);
    expect(
      (await alfa.get('/api/payments')).body.items.map((p: { name: string }) => p.name),
    ).toEqual(['Czynsz']);
  });

  it('przegląd dnia przypomina o niezapłaconej płatności w dniu terminu', async () => {
    const day = Number(today.slice(8, 10));
    await alfa.post('/api/payments', {
      name: 'Kredyt',
      amount: 450,
      dayOfMonth: day,
      space: 'private',
    });
    const digest = () =>
      buildDigest(
        t.deps,
        { userId: t.seed.users.alfa, householdId: t.seed.householdId, displayName: 'Alfa (test)' },
        'morning',
      );
    expect((await digest()).body).toContain('Płatność: Kredyt — 450,00');
    const id = (await alfa.get('/api/payments')).body.items[0].id;
    await alfa.post(`/api/payments/${id}/paid`);
    expect((await digest()).body).not.toContain('Kredyt');
  });

  it('daty: ostatni dzień miesiąca', () => {
    expect(dueDateIn('2027-02', 31)).toBe('2027-02-28');
    expect(dueDateIn('2028-02', 30)).toBe('2028-02-29');
    expect(monthEnd('2026-12')).toBe('2026-12-31');
    expect(nextMonth('2026-12')).toBe('2027-01');
  });
});
