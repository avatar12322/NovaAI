import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { seedDev } from '../db/seed';
import { createTestApp, login, truncateAll, type Client, type TestApp } from '../test/helpers';

/** M6 — przypomnienia: deterministyczne, trwałe, z priorytetem prywatności i niezależne od budżetu modeli. */
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

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
/** „Przewinięcie czasu”: termin przypomnień i zadań na teraz. */
const makeDue = async () => {
  await t.db.owner.query(`UPDATE tasks SET run_after = now() WHERE kind = 'reminder.fire'`);
};
const notes = async (c: Client) =>
  (await c.get('/api/notifications')).body.items as Array<{
    kind: string;
    body: string;
    title: string;
  }>;

describe('dostarczanie przypomnień', () => {
  it('prywatne: nie przed terminem; w terminie tylko do właściciela', async () => {
    const r = await alfa.post('/api/reminders', { text: 'Leki o 21:00', dueAt: inMinutes(5) });
    expect(r.status).toBe(201);
    await t.drain();
    expect(await notes(alfa)).toHaveLength(0);
    await makeDue();
    await t.drain();
    expect((await notes(alfa)).map((n) => n.body)).toEqual(['Leki o 21:00']);
    expect(await notes(beta)).toHaveLength(0);
    const list = (await alfa.get('/api/reminders')).body.items;
    expect(list[0]).toMatchObject({ status: 'fired', visibility: 'private' });
    expect((await beta.get('/api/reminders?space=private')).body.items).toHaveLength(0);
    expect((await beta.get('/api/reminders?space=shared')).body.items).toHaveLength(0);
  });

  it('wspólne: trafia do obojga domowników', async () => {
    await alfa.post('/api/reminders', {
      text: 'Wynieść śmieci',
      dueAt: inMinutes(5),
      space: 'shared',
    });
    expect((await beta.get('/api/reminders?space=shared')).body.items[0]).toMatchObject({
      text: 'Wynieść śmieci',
      isMine: false,
    });
    await makeDue();
    await t.drain();
    expect((await notes(alfa)).map((n) => n.title)).toEqual(['Przypomnienie (wspólne)']);
    expect((await notes(beta)).map((n) => n.body)).toEqual(['Wynieść śmieci']);
  });

  it('anulowane przypomnienie nie jest dostarczane; Beta nie anuluje przypomnienia Alfy', async () => {
    const r = await alfa.post('/api/reminders', {
      text: 'Anuluj mnie',
      dueAt: inMinutes(5),
      space: 'shared',
    });
    expect((await beta.del(`/api/reminders/${r.body.id}`)).status).toBe(404);
    expect((await alfa.del(`/api/reminders/${r.body.id}`)).status).toBe(204);
    await makeDue();
    await t.drain();
    expect(await notes(alfa)).toHaveLength(0);
    expect(await notes(beta)).toHaveLength(0);
  });

  it('działa przy zablokowanym budżecie modeli (bez płatnych wywołań)', async () => {
    await alfa.put('/api/budget', { softLimit: null, hardLimit: 0, paidCallsEnabled: false });
    await alfa.post('/api/reminders', { text: 'Mimo limitu', dueAt: inMinutes(5) });
    await makeDue();
    await t.drain();
    expect((await notes(alfa)).map((n) => n.body)).toEqual(['Mimo limitu']);
    const usage = await t.db.owner.query(`SELECT count(*)::int AS n FROM usage_records`);
    expect(usage.rows[0].n).toBe(0);
  });

  it('po odebraniu członkostwa wspólne przypomnienie autora nie jest dostarczane nikomu', async () => {
    await alfa.post('/api/reminders', {
      text: 'Po odejściu',
      dueAt: inMinutes(5),
      space: 'shared',
    });
    await t.db.owner.query(
      `UPDATE memberships SET status = 'revoked', revoked_at = now() WHERE user_id = $1`,
      [t.seed.users.alfa],
    );
    await makeDue();
    await t.drain();
    expect((await t.db.owner.query(`SELECT count(*)::int AS n FROM notifications`)).rows[0].n).toBe(
      0,
    );
    const task = await t.db.owner.query(`SELECT status FROM tasks WHERE kind = 'reminder.fire'`);
    expect(task.rows[0].status).toBe('failed');
  });

  it('przypomnienie przeżywa restart serwera (nowa instancja kolejki je dostarcza)', async () => {
    await alfa.post('/api/reminders', { text: 'Po restarcie', dueAt: inMinutes(5) });
    await makeDue();
    const { runner, deps } = createApp(t.config, t.db, { runnerWorkerId: 'after-restart' });
    await runner.drain();
    await deps.events.stop();
    expect((await notes(alfa)).map((n) => n.body)).toEqual(['Po restarcie']);
  });

  it('ponowne przetworzenie nie duplikuje powiadomień', async () => {
    await alfa.post('/api/reminders', { text: 'Raz', dueAt: inMinutes(5), space: 'shared' });
    await makeDue();
    await t.drain();
    await t.db.owner.query(`UPDATE reminders SET status = 'scheduled'`);
    await t.db.owner.query(
      `UPDATE tasks SET status = 'queued', run_after = now() WHERE kind = 'reminder.fire'`,
    );
    await t.db.owner.query(`UPDATE task_steps SET status = 'pending'`);
    await t.drain();
    expect(await notes(alfa)).toHaveLength(1);
    expect(await notes(beta)).toHaveLength(1);
  });
});

describe('odczyt powiadomień', () => {
  it('„przeczytane”: zdarzenie notification.read tylko dla właściciela i tylko raz', async () => {
    await alfa.post('/api/reminders', { text: 'Leki o 21:00', dueAt: inMinutes(5) });
    await makeDue();
    await t.drain();
    const [n] = (await alfa.get('/api/notifications')).body.items as Array<{ id: string }>;
    const before = (await t.db.owner.query(`SELECT coalesce(max(id), 0)::int AS id FROM events`))
      .rows[0].id as number;
    const readEvents = async (c: Client) =>
      (
        (await c.get(`/api/events?after=${before}`)).body.items as Array<{
          type: string;
          payload: unknown;
        }>
      ).filter((e) => e.type === 'notification.read');

    expect((await beta.post(`/api/notifications/${n!.id}/read`)).body).toEqual({ ok: false });
    expect((await alfa.post(`/api/notifications/${n!.id}/read`)).body).toEqual({ ok: true });
    expect((await alfa.post(`/api/notifications/${n!.id}/read`)).body).toEqual({ ok: false });
    expect((await alfa.get('/api/notifications')).body.unread).toBe(0);
    expect((await readEvents(alfa)).map((e) => e.payload)).toEqual([{ notificationId: n!.id }]);
    expect(await readEvents(beta)).toHaveLength(0);
  });
});

describe('walidacja i czat', () => {
  it('termin w przeszłości lub > 1 rok => 400', async () => {
    expect(
      (await alfa.post('/api/reminders', { text: 'x', dueAt: '2020-01-01T00:00:00Z' })).status,
    ).toBe(400);
    expect(
      (
        await alfa.post('/api/reminders', {
          text: 'x',
          dueAt: new Date(Date.now() + 400 * 86400_000).toISOString(),
        })
      ).status,
    ).toBe(400);
  });

  it('„przypomnij mi” w czacie prywatnym tworzy prywatne, „przypomnij nam” w NovaAI — wspólne', async () => {
    let conv = (await alfa.post('/api/conversations', { space: 'private' })).body;
    await alfa.post(`/api/conversations/${conv.id}/messages`, {
      content: 'przypomnij mi za 10 minut: wyłączyć piekarnik',
    });
    await t.drain();
    conv = (await beta.post('/api/conversations', { space: 'shared' })).body;
    await beta.post(`/api/conversations/${conv.id}/messages`, {
      content: 'przypomnij nam za 2 godz: zakupy',
    });
    await t.drain();
    const rows = await t.db.owner.query(
      `SELECT owner_user_id, visibility, text, status FROM reminders ORDER BY created_at`,
    );
    expect(rows.rows).toEqual([
      {
        owner_user_id: t.seed.users.alfa,
        visibility: 'private',
        text: 'wyłączyć piekarnik',
        status: 'scheduled',
      },
      {
        owner_user_id: t.seed.users.beta,
        visibility: 'shared',
        text: 'zakupy',
        status: 'scheduled',
      },
    ]);
    expect(
      (await alfa.get('/api/reminders?space=shared')).body.items.map((r: any) => r.text),
    ).toEqual(['zakupy']);
  });
});
