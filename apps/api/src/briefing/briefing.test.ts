import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDev } from '../db/seed';
import { createTestApp, login, truncateAll, type Client, type TestApp } from '../test/helpers';
import { plural } from './routes';

/** Poranny przegląd: dane dnia z uprawnieniami użytkownika i tekst do odczytu na głos. */
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

/** Dzień w strefie Europe/Warsaw przesunięty o `days` (RRRR-MM-DD). */
const warsawDate = (days: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(
    new Date(Date.now() + days * 86_400_000),
  );

async function reminder(userId: string, text: string, visibility: 'private' | 'shared') {
  await t.db.owner.query(
    `INSERT INTO reminders (household_id, owner_user_id, visibility, text, due_at)
     VALUES ($1, $2, $3, $4, now() + interval '1 second')`,
    [t.seed.householdId, userId, visibility, text],
  );
}

describe('poranny przegląd', () => {
  it('dzień Alfy: przypomnienia, kalendarz, zgoda, odnowienie, budżet — i tekst na głos', async () => {
    await reminder(t.seed.users.alfa, 'Wziąć leki', 'private');
    await reminder(t.seed.users.alfa, 'Wynieść śmieci', 'shared');
    await t.db.owner.query(
      `INSERT INTO local_calendar_events (household_id, owner_user_id, title, starts_at, ends_at)
       VALUES ($1, $2, 'Dentysta', now(), now() + interval '1 hour')`,
      [t.seed.householdId, t.seed.users.alfa],
    );
    const svc = await alfa.post('/api/services', {
      name: 'VPS test',
      category: 'vps',
      billingPeriod: 'monthly',
      currency: 'PLN',
      renewsOn: warsawDate(3),
      remindDaysBefore: 0, // własne przypomnienie usługi dopiero w dniu odnowienia
    });
    expect(svc.status).toBe(201);
    await alfa.put('/api/budget', { softLimit: null, hardLimit: 50, paidCallsEnabled: true });
    // Akcja wymagająca zgody (tryb demo: wiadomość do domownika).
    const conv = (await alfa.post('/api/conversations', { space: 'private' })).body;
    await alfa.post(`/api/conversations/${conv.id}/messages`, {
      content: 'napisz do domownika: kolacja o 19',
    });
    await t.drain();

    const b = (await alfa.get('/api/briefing')).body;
    expect(b.greeting).toMatch(/^(Dzień dobry|Dobry wieczór), Alfa$/);
    expect(b.date).toBe(warsawDate(0));
    expect(b.reminders.map((r: any) => [r.text, r.shared])).toEqual([
      ['Wziąć leki', false],
      ['Wynieść śmieci', true],
    ]);
    expect(b.events.map((e: any) => e.title)).toEqual(['Dentysta']);
    expect(b.approvals).toBe(1);
    expect(b.renewals).toEqual([
      { serviceId: svc.body.id, name: 'VPS test', renewsOn: warsawDate(3), daysLeft: 3 },
    ]);
    expect(b.budget).toMatchObject({ hardLimit: 50, currency: 'PLN' });
    expect(b.summary).toContain(`${b.greeting}. Dziś ${b.dateLabel}.`);
    expect(b.summary).toContain('W kalendarzu:');
    expect(b.summary).toContain('Dentysta');
    expect(b.summary).toContain('Przypomnienia: Wziąć leki o');
    expect(b.summary).toContain('1 akcja czeka na Twoją zgodę.');
    expect(b.summary).toContain('Wkrótce odnowienie: VPS test (za 3 dni).');
    expect(b.summary).toMatch(/Koszt modeli w tym miesiącu: 0,00\szł z limitu 50,00\szł\./);
  });

  it('Beta nie widzi prywatnych danych Alfy, widzi wspólne przypomnienie', async () => {
    await reminder(t.seed.users.alfa, 'Wziąć leki', 'private');
    await reminder(t.seed.users.alfa, 'Wynieść śmieci', 'shared');
    await t.db.owner.query(
      `INSERT INTO local_calendar_events (household_id, owner_user_id, title, starts_at, ends_at)
       VALUES ($1, $2, 'Dentysta', now(), now() + interval '1 hour')`,
      [t.seed.householdId, t.seed.users.alfa],
    );
    await alfa.post('/api/services', {
      name: 'Prywatny VPS',
      category: 'vps',
      billingPeriod: 'monthly',
      currency: 'PLN',
      renewsOn: warsawDate(2),
    });
    const b = (await beta.get('/api/briefing')).body;
    expect(b.greeting).toMatch(/, Beta$/);
    expect(b.reminders.map((r: any) => r.text)).toEqual(['Wynieść śmieci']);
    expect(b.events).toEqual([]);
    expect(b.renewals).toEqual([]);
    expect(b.approvals).toBe(0);
    const all = JSON.stringify(b);
    for (const secret of ['Wziąć leki', 'Dentysta', 'Prywatny VPS'])
      expect(all).not.toContain(secret);
  });

  it('pusty dzień: krótki tekst bez list', async () => {
    const b = (await alfa.get('/api/briefing')).body;
    expect(b.summary).toBe(`${b.greeting}. Dziś ${b.dateLabel}. Nic pilnego — spokojny dzień.`);
    expect((await t.app.inject({ method: 'GET', url: '/api/briefing' })).statusCode).toBe(401);
  });

  it('polska odmiana liczebników', () => {
    const f = (n: number) => plural(n, 'zadanie', 'zadania', 'zadań');
    expect([1, 2, 4, 5, 12, 14, 22, 25, 101].map(f)).toEqual([
      '1 zadanie',
      '2 zadania',
      '4 zadania',
      '5 zadań',
      '12 zadań',
      '14 zadań',
      '22 zadania',
      '25 zadań',
      '101 zadań',
    ]);
  });
});
