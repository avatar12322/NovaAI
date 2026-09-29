import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { wallClockToUtc } from '../calendar/ics';
import { seedDev } from '../db/seed';
import { buildDigest, TZ, warsawClock } from '../digest/service';
import { createTestApp, login, truncateAll, type Client, type TestApp } from '../test/helpers';

/** Terminy (prywatne, w przeglądach dnia z wyprzedzeniem) i fiszki (Leitner). */
let t: TestApp;
let alfa: Client;
let beta: Client;

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const today = warsawClock(new Date()).date;
const at = (date: string, h: number, m: number) => {
  const [y, mo, d] = date.split('-').map(Number);
  return wallClockToUtc(y!, mo!, d!, h, m, 0, TZ);
};

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

const alfaUser = () => ({
  userId: t.seed.users.alfa,
  householdId: t.seed.householdId,
  displayName: 'Alfa (test)',
});

describe('terminy', () => {
  it('dodanie z godziną i na cały dzień, prywatne, zrobione, w przeszłości — odrzucone', async () => {
    const d5 = addDays(today, 5);
    const exam = await alfa.post('/api/deadlines', {
      title: 'Kolokwium',
      subject: 'Analiza danych',
      kind: 'egzamin',
      due: `${d5}T10:00`,
    });
    expect(exam.status).toBe(201);
    expect(new Date(exam.body.deadline.dueAt).toISOString()).toBe(at(d5, 10, 0).toISOString());
    await alfa.post('/api/deadlines', {
      title: 'Projekt',
      kind: 'oddanie',
      due: addDays(today, 2),
    });
    const list = (await alfa.get('/api/deadlines')).body.items;
    expect(list.map((d: { title: string }) => d.title)).toEqual(['Projekt', 'Kolokwium']);
    expect(list[0].allDay).toBe(true);
    expect((await beta.get('/api/deadlines')).body.items).toEqual([]);
    expect(
      (await beta.patch(`/api/deadlines/${exam.body.deadline.id}`, { done: true })).status,
    ).toBe(404);
    expect(
      (await alfa.patch(`/api/deadlines/${exam.body.deadline.id}`, { done: true })).status,
    ).toBe(200);
    expect((await alfa.get('/api/deadlines')).body.items.at(-1).done).toBe(true);
    expect(
      (await alfa.post('/api/deadlines', { title: 'x', due: addDays(today, -3) })).status,
    ).toBe(400);
    expect((await alfa.post('/api/deadlines', { title: 'x', due: 'jutro' })).status).toBe(400);
  });

  it('przegląd dnia: zapowiedź 3 dni wcześniej, wieczór przed, rano w dniu; fiszki do powtórki', async () => {
    const d = addDays(today, 4);
    await alfa.post('/api/deadlines', {
      title: 'Kolokwium',
      subject: 'Analiza danych',
      kind: 'egzamin',
      due: `${d}T10:00`,
    });
    const three = await buildDigest(t.deps, alfaUser(), 'morning', at(addDays(d, -3), 7, 0));
    expect(three.body).toContain('Za 3 dni — egzamin / kolokwium: Kolokwium (Analiza danych)');
    const eve = await buildDigest(t.deps, alfaUser(), 'evening', at(addDays(d, -1), 22, 0));
    expect(eve.body).toContain('Egzamin / kolokwium: Kolokwium (Analiza danych), 10:00');
    const morning = await buildDigest(t.deps, alfaUser(), 'morning', at(d, 7, 0));
    expect(morning.body).toContain('Egzamin / kolokwium: Kolokwium');

    await alfa.post('/api/flashcards/decks', {
      title: 'Narrative design',
      cards: [{ front: 'Łuk bohatera?', back: 'Przemiana postaci w fabule' }],
    });
    const now = await buildDigest(t.deps, alfaUser(), 'morning');
    expect(now.body).toContain('Fiszki do powtórki: 1');
    const betaDigest = await buildDigest(
      t.deps,
      { userId: t.seed.users.beta, householdId: t.seed.householdId, displayName: 'Beta' },
      'morning',
    );
    expect(betaDigest.body).not.toContain('Fiszki');
  });
});

describe('fiszki', () => {
  it('talia, powtórka: umiem → dłuższa przerwa, nie umiem → jutro; dopisanie do talii; prywatne', async () => {
    const r = await alfa.post('/api/flashcards/decks', {
      title: 'Analiza danych',
      subject: 'Analiza danych',
      cards: [
        { front: 'Mediana?', back: 'Wartość środkowa' },
        { front: 'Odchylenie standardowe?', back: 'Miara rozrzutu' },
      ],
    });
    expect(r.status).toBe(201);
    const deckId = r.body.deckId as string;
    // Ta sama nazwa (bez względu na wielkość liter) — dopisanie kart.
    const again = await alfa.post('/api/flashcards/decks', {
      title: 'analiza DANYCH',
      cards: [{ front: 'Średnia?', back: 'Suma / liczba' }],
    });
    expect(again.body.deckId).toBe(deckId);
    const decks = (await alfa.get('/api/flashcards/decks')).body.items;
    expect(decks).toEqual([expect.objectContaining({ id: deckId, cards: 3, due: 3, learned: 0 })]);
    expect((await beta.get('/api/flashcards/decks')).body.items).toEqual([]);
    expect((await beta.get(`/api/flashcards/decks/${deckId}/due`)).body.items).toEqual([]);

    const due = (await alfa.get(`/api/flashcards/decks/${deckId}/due`)).body.items;
    expect(due).toHaveLength(3);
    const ok = await alfa.post(`/api/flashcards/${due[0].id}/review`, { known: true });
    expect(ok.body).toEqual({ box: 2, dueOn: addDays(today, 2) });
    const bad = await alfa.post(`/api/flashcards/${due[1].id}/review`, { known: false });
    expect(bad.body).toEqual({ box: 1, dueOn: addDays(today, 1) });
    expect((await beta.post(`/api/flashcards/${due[2].id}/review`, { known: true })).status).toBe(
      404,
    );
    expect((await alfa.get(`/api/flashcards/decks/${deckId}/due`)).body.items).toHaveLength(1);

    expect((await alfa.del(`/api/flashcards/decks/${deckId}`)).status).toBe(204);
    const left = await t.db.owner.query('SELECT count(*)::int AS n FROM flashcards');
    expect(left.rows[0].n).toBe(0);
  });
});
