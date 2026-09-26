import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDev } from '../db/seed';
import { withUserTx } from '../db/pool';
import { createTestApp, login, truncateAll, type Client, type TestApp } from '../test/helpers';
import { decimalToMicros } from './adapters';
import { countedKind, nextRenewal, nineAmWarsaw } from './service';

/**
 * „Usługi i koszty”: izolacja prywatne/wspólne, waluty, odnowienia z przypomnieniami, budżet, brak podwójnego
 * liczenia, deduplikacja faktur, brak sekretów oraz adaptery raportów kosztów na lokalnej atrapie
 * (Anthropic Cost API, OpenAI Costs API). Atrapa ≠ prawdziwe konto: adaptery nie są „sprawdzone” z dostawcami.
 */
const ANTHROPIC_KEY = 'sk-ant-admin01-TESTKEY-0000000000000000';
const OPENAI_KEY = 'sk-admin-TESTKEY-0000000000000000';

interface AdapterMock {
  mode: 'ok' | 'unauthorized';
  anthropicCents: Array<{ day: string; amount: string }>;
  openaiDollars: Array<{ day: string; value: number }>;
  calls: Array<{ path: string; query: Record<string, string>; headers: Record<string, string> }>;
}
const am: AdapterMock = { mode: 'ok', anthropicCents: [], openaiDollars: [], calls: [] };
let server: Server;
let base: string;

function startMock(): Promise<void> {
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
    am.calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (am.mode === 'unauthorized') return send(401, { error: { type: 'authentication_error' } });
    if (url.pathname === '/anthropic/v1/organizations/cost_report') {
      if (
        req.headers['x-api-key'] !== ANTHROPIC_KEY ||
        req.headers['anthropic-version'] !== '2023-06-01'
      )
        return send(401, {});
      // Dwie strony: każdy dzień w osobnym kubełku, stronicowanie next_page.
      const page = url.searchParams.get('page');
      const days = [...new Set(am.anthropicCents.map((a) => a.day))];
      const pick = page === 'p2' ? days.slice(1) : days.slice(0, 1);
      return send(200, {
        data: pick.map((d) => ({
          starting_at: `${d}T00:00:00Z`,
          ending_at: `${d}T23:59:59Z`,
          results: am.anthropicCents
            .filter((a) => a.day === d)
            .map((a) => ({
              amount: a.amount,
              currency: 'USD',
              cost_type: null,
              description: null,
            })),
        })),
        has_more: page !== 'p2' && days.length > 1,
        next_page: page !== 'p2' && days.length > 1 ? 'p2' : null,
      });
    }
    if (url.pathname === '/openai/v1/organization/costs') {
      if (req.headers.authorization !== `Bearer ${OPENAI_KEY}`) return send(401, {});
      return send(200, {
        object: 'page',
        data: am.openaiDollars.map((o) => ({
          object: 'bucket',
          start_time: Date.parse(`${o.day}T00:00:00Z`) / 1000,
          end_time: Date.parse(`${o.day}T00:00:00Z`) / 1000 + 86_400,
          results: [
            {
              object: 'organization.costs.result',
              amount: { value: o.value, currency: 'usd' },
              line_item: null,
              project_id: null,
            },
          ],
        })),
        has_more: false,
        next_page: null,
      });
    }
    send(404, {});
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r()));
}

let t: TestApp;
let alfa: Client;
let beta: Client;

beforeAll(async () => {
  await startMock();
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t = await createTestApp(
    { ANTHROPIC_ADMIN_API_KEY: ANTHROPIC_KEY, OPENAI_ADMIN_API_KEY: OPENAI_KEY },
    { costAdapterBases: { anthropic: `${base}/anthropic`, openai: `${base}/openai` } },
  );
});
afterAll(async () => {
  await t.close();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(async () => {
  await truncateAll(t.db);
  t.seed = await seedDev(t.db, 'test');
  alfa = await login(t.app, 'alfa');
  beta = await login(t.app, 'beta');
  Object.assign(am, { mode: 'ok', anthropicCents: [], openaiDollars: [], calls: [] });
});

const month = new Date().toISOString().slice(0, 7);
const prevMonth = (() => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
})();
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function createService(c: Client, over: Record<string, unknown> = {}) {
  const r = await c.post('/api/services', {
    name: 'VPS produkcja',
    category: 'vps',
    purpose: 'Serwer aplikacji NovaAI',
    panelUrl: 'https://panel.example.test/servers',
    billingPeriod: 'monthly',
    currency: 'PLN',
    plan: 'CX22',
    ...over,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}
const addCost = (c: Client, id: string, body: Record<string, unknown>) =>
  c.post(`/api/services/${id}/costs`, { currency: 'PLN', month, ...body });
const summary = async (c: Client, space = 'all', m = month) =>
  (await c.get(`/api/costs/summary?space=${space}&month=${m}`)).body;
const micros = (pln: number) => Math.round(pln * 1_000_000);

describe('izolacja: dane prywatne i jawnie wspólne', () => {
  it('prywatna usługa Alfy jest niewidoczna dla Bety; po udostępnieniu — tylko do odczytu; cofnięcie działa', async () => {
    const s = await createService(alfa, { monthlyBudget: '100' });
    await addCost(alfa, s.id, {
      kind: 'invoice',
      amount: '49,99',
      invoiceNumber: 'FV/1',
      paidOn: inDays(-1),
    });

    expect((await beta.get('/api/services')).body.items).toEqual([]);
    expect((await beta.get(`/api/services/${s.id}`)).status).toBe(404);
    expect((await addCost(beta, s.id, { kind: 'estimate', amount: '1' })).status).toBe(404);
    expect((await summary(beta)).totals).toEqual([]);
    // Druga warstwa: RLS w bazie.
    const rls = await withUserTx(t.db, { userId: t.seed.users.beta, scope: 'user' }, async (c) => [
      (await c.query('SELECT count(*)::int AS n FROM services')).rows[0].n,
      (await c.query('SELECT count(*)::int AS n FROM service_costs')).rows[0].n,
    ]);
    expect(rls).toEqual([0, 0]);

    expect((await alfa.post(`/api/services/${s.id}/share`)).status).toBe(200);
    const shared = (await beta.get('/api/services?space=shared')).body.items;
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({
      name: 'VPS produkcja',
      isMine: false,
      ownerName: 'Alfa (test)',
    });
    expect((await beta.get(`/api/services/${s.id}`)).body.entries).toHaveLength(1);
    expect((await summary(beta)).totals).toEqual([{ currency: 'PLN', micros: micros(49.99) }]);
    // Beta tylko czyta.
    expect((await beta.patch(`/api/services/${s.id}`, { name: 'x' })).status).toBe(403);
    expect((await addCost(beta, s.id, { kind: 'estimate', amount: '1' })).status).toBe(403);
    expect((await beta.del(`/api/services/${s.id}`)).status).toBe(403);
    expect((await beta.post(`/api/services/${s.id}/unshare`)).status).toBe(403);
    // NovaAI (zakres „shared”) widzi tylko wspólne.
    const nova = await withUserTx(t.db, { userId: t.seed.users.beta, scope: 'shared' }, (c) =>
      c.query('SELECT name FROM services'),
    );
    expect(nova.rows.map((r) => r.name)).toEqual(['VPS produkcja']);

    expect((await alfa.post(`/api/services/${s.id}/unshare`)).status).toBe(200);
    expect((await beta.get('/api/services')).body.items).toEqual([]);
    expect((await beta.get(`/api/services/${s.id}`)).status).toBe(404);
  });

  it('dostawca modeli przypisany do cudzej usługi: odmowa bez ujawniania, czyja to usługa', async () => {
    await createService(alfa, {
      name: 'Tajny projekt Alfy',
      category: 'model_api',
      modelProvider: 'anthropic',
    });
    const r = await beta.post('/api/services', {
      name: 'Claude',
      category: 'model_api',
      billingPeriod: 'usage',
      currency: 'USD',
      modelProvider: 'anthropic',
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('already_linked');
    expect(JSON.stringify(r.body)).not.toContain('Tajny');
  });
});

describe('filtr widoczności listy i sumy', () => {
  it('„Prywatne”, „Wspólne” i „Wszystkie” działają dla listy i sumy miesiąca', async () => {
    const own = await createService(alfa, { name: 'Prywatny VPS' });
    const shared = await createService(alfa, {
      name: 'Wspólna domena',
      category: 'domain',
      space: 'shared',
    });
    const other = await createService(beta, { name: 'Prywatne Bety' });
    await addCost(alfa, own.id, { kind: 'estimate', amount: '10' });
    await addCost(alfa, shared.id, { kind: 'estimate', amount: '5' });
    await addCost(beta, other.id, { kind: 'estimate', amount: '7' });
    const names = async (c: Client, space: string) => {
      const r = await c.get(`/api/services?space=${space}&month=${month}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body.items.map((x: any) => x.name);
    };
    expect(await names(alfa, 'private')).toEqual(['Prywatny VPS']);
    expect(await names(alfa, 'shared')).toEqual(['Wspólna domena']);
    expect(await names(alfa, 'all')).toEqual(['Prywatny VPS', 'Wspólna domena']);
    expect(await names(beta, 'private')).toEqual(['Prywatne Bety']);
    expect(await names(beta, 'all')).toEqual(['Prywatne Bety', 'Wspólna domena']);
    for (const [space, total] of [
      ['private', 10],
      ['shared', 5],
      ['all', 15],
    ] as const) {
      const r = await alfa.get(`/api/costs/summary?space=${space}&month=${month}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.totals).toEqual([{ currency: 'PLN', micros: micros(total) }]);
    }
  });
});

describe('suma miesiąca: każda opłata liczona raz', () => {
  it('faktura zastępuje raport, raport zastępuje szacunek — w obrębie usługi i miesiąca', async () => {
    const s = await createService(alfa);
    await addCost(alfa, s.id, { kind: 'estimate', amount: '50' });
    await addCost(alfa, s.id, { kind: 'report', amount: '60' });
    let d = (await alfa.get(`/api/services/${s.id}`)).body;
    expect(d.current).toMatchObject({
      countedKind: 'report',
      totals: [{ currency: 'PLN', micros: micros(60) }],
    });
    await addCost(alfa, s.id, { kind: 'invoice', amount: '70', invoiceNumber: 'FV/9' });
    d = (await alfa.get(`/api/services/${s.id}`)).body;
    expect(d.current).toMatchObject({
      countedKind: 'invoice',
      totals: [{ currency: 'PLN', micros: micros(70) }],
    });
    expect(d.entries.map((e: any) => [e.kind, e.counted])).toEqual([
      ['invoice', true],
      ['report', false],
      ['estimate', false],
    ]);
    // Inny miesiąc liczy się osobno.
    await addCost(alfa, s.id, { kind: 'estimate', amount: '5', month: prevMonth });
    const sum = await summary(alfa);
    expect(sum.totals).toEqual([{ currency: 'PLN', micros: micros(70) }]);
    // Faktura bez daty zapłaty = „do zapłaty”.
    expect(sum.byKind).toEqual([{ kind: 'invoice_unpaid', currency: 'PLN', micros: micros(70) }]);
    expect((await summary(alfa, 'all', prevMonth)).byKind).toEqual([
      { kind: 'estimate', currency: 'PLN', micros: micros(5) },
    ]);
    expect(countedKind(['estimate', 'invoice', 'report'])).toBe('invoice');
  });

  it('szacunek z zapisanych wywołań modeli; po fakturze nie jest doliczany', async () => {
    const s = await createService(alfa, {
      name: 'Claude API',
      category: 'model_api',
      billingPeriod: 'usage',
      currency: 'PLN',
      modelProvider: 'anthropic',
    });
    const usage = async (provider: string, costPln: number, status = 'final', paid = true) =>
      t.db.owner.query(
        `INSERT INTO usage_records (household_id, owner_user_id, provider, model, capability, status, cost_micros, currency, paid)
         VALUES ($1, $2, $3, 'claude-test', 'chat.simple', $4, $5, 'PLN', $6)`,
        [t.seed.householdId, t.seed.users.beta, provider, status, micros(costPln), paid],
      );
    await usage('anthropic', 1.25);
    await usage('anthropic', 0.75);
    await usage('anthropic', 9, 'failed');
    await usage('anthropic', 9, 'final', false); // niepłatne (np. tryb bez cennika)
    await usage('openai', 3);
    let d = (await alfa.get(`/api/services/${s.id}`)).body;
    expect(d.current).toMatchObject({
      countedKind: 'estimate',
      totals: [{ currency: 'PLN', micros: micros(2) }],
      modelEstimate: [{ currency: 'PLN', micros: micros(2) }],
    });
    await addCost(alfa, s.id, {
      kind: 'invoice',
      amount: '2,40',
      invoiceNumber: 'INV-7',
      paidOn: inDays(0),
    });
    d = (await alfa.get(`/api/services/${s.id}`)).body;
    expect(d.current).toMatchObject({
      countedKind: 'invoice',
      totals: [{ currency: 'PLN', micros: micros(2.4) }],
    });
    expect((await summary(alfa)).byKind).toEqual([
      { kind: 'invoice', currency: 'PLN', micros: micros(2.4) },
    ]);
  });
});

describe('waluty', () => {
  it('sumy osobno dla każdej waluty; budżet porównuje tylko walutę usługi', async () => {
    const s = await createService(alfa, { name: 'Hosting', currency: 'usd', monthlyBudget: '10' });
    expect(s.currency).toBe('USD');
    await addCost(alfa, s.id, { kind: 'report', amount: '8', currency: 'USD' });
    await addCost(alfa, s.id, { kind: 'report', amount: '30', currency: 'EUR' });
    const d = (await alfa.get(`/api/services/${s.id}`)).body;
    expect(d.current.totals).toEqual([
      { currency: 'USD', micros: micros(8) },
      { currency: 'EUR', micros: micros(30) },
    ]);
    expect(d.current.budget).toEqual({
      micros: micros(10),
      currency: 'USD',
      spentMicros: micros(8),
      state: 'near',
    });
    expect(d.current.otherCurrencies).toEqual(['EUR']);
    const j = await createService(alfa, {
      name: 'Domena .jp',
      category: 'domain',
      currency: 'JPY',
      billingPeriod: 'yearly',
    });
    expect(
      (
        await addCost(alfa, j.id, {
          kind: 'invoice',
          amount: '1500',
          currency: 'JPY',
          invoiceNumber: 'J1',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await addCost(alfa, j.id, {
          kind: 'invoice',
          amount: '1500.5',
          currency: 'JPY',
          invoiceNumber: 'J2',
        })
      ).status,
    ).toBe(400);
    expect(
      (await addCost(alfa, s.id, { kind: 'report', amount: '1.234', currency: 'USD' })).status,
    ).toBe(400);
    expect(
      (
        await alfa.post('/api/services', {
          name: 'x',
          category: 'other',
          billingPeriod: 'monthly',
          currency: 'XYZ',
        })
      ).status,
    ).toBe(400);
    const sum = await summary(alfa);
    // Suma miesiąca: każda waluta osobno (bez przeliczania), alfabetycznie.
    expect(sum.totals).toEqual([
      { currency: 'EUR', micros: micros(30) },
      { currency: 'JPY', micros: micros(1500) },
      { currency: 'USD', micros: micros(8) },
    ]);
  });
});

describe('odnowienia i przypomnienia', () => {
  it('przypomnienie N dni przed odnowieniem o 9:00 czasu polskiego; zmiana daty i anulowanie usługi', async () => {
    const renews = inDays(20);
    const s = await createService(alfa, { renewsOn: renews, remindDaysBefore: 5 });
    expect(s.reminderScheduled).toBe(true);
    const r1 = await t.db.owner.query(`SELECT due_at, visibility, status, text FROM reminders`);
    expect(new Date(r1.rows[0].due_at).toISOString()).toBe(nineAmWarsaw(inDays(15)).toISOString());
    expect(r1.rows[0]).toMatchObject({ visibility: 'private', status: 'scheduled' });
    expect(r1.rows[0].text).toContain('Odnowienie: VPS produkcja (CX22)');

    await alfa.patch(`/api/services/${s.id}`, { renewsOn: inDays(40) });
    const r2 = await t.db.owner.query(`SELECT status FROM reminders ORDER BY created_at`);
    expect(r2.rows.map((r) => r.status)).toEqual(['cancelled', 'scheduled']);

    await alfa.patch(`/api/services/${s.id}`, { status: 'cancelled' });
    const r3 = await t.db.owner.query(`SELECT status FROM reminders ORDER BY created_at`);
    expect(r3.rows.map((r) => r.status)).toEqual(['cancelled', 'cancelled']);
    expect((await alfa.get(`/api/services/${s.id}`)).body.reminderScheduled).toBe(false);
  });

  it('wspólna usługa: przypomnienie trafia do obojga; bliski termin — przypomnienie od razu', async () => {
    const s = await createService(alfa, {
      space: 'shared',
      renewsOn: inDays(2),
      remindDaysBefore: 7,
    });
    const r = await t.db.owner.query(`SELECT id, due_at, visibility, task_id FROM reminders`);
    expect(r.rows[0].visibility).toBe('shared');
    expect(Date.parse(r.rows[0].due_at) - Date.now()).toBeLessThan(120_000);
    await t.db.owner.query(`UPDATE tasks SET run_after = now() WHERE id = $1`, [r.rows[0].task_id]);
    await t.drain();
    for (const c of [alfa, beta]) {
      const n = (await c.get('/api/notifications')).body;
      expect(JSON.stringify(n)).toContain(`Odnowienie: VPS produkcja (CX22) — ${inDays(2)}`);
    }
    expect(s.visibility).toBe('shared');
  });

  it('„odnowiono”: następny termin z zachowaniem dnia miesiąca; data w przeszłości — ostrzeżenie', async () => {
    expect(nextRenewal('2027-01-31', 31, 'monthly')).toBe('2027-02-28');
    expect(nextRenewal('2027-02-28', 31, 'monthly')).toBe('2027-03-31');
    expect(nextRenewal('2028-01-31', 31, 'monthly')).toBe('2028-02-29');
    expect(nextRenewal('2026-11-30', 30, 'quarterly')).toBe('2027-02-28');
    expect(nextRenewal('2028-02-29', 29, 'yearly')).toBe('2029-02-28');
    expect(nextRenewal('2026-10-01', 1, 'usage')).toBeNull();

    const past = await createService(alfa, { renewsOn: inDays(-3) });
    expect(past.warnings[0]).toContain('Data odnowienia już minęła');
    const r = await alfa.post(`/api/services/${past.id}/renewed`);
    expect(r.body.renewsOn).toBe(nextRenewal(inDays(-3), Number(inDays(-3).slice(8)), 'monthly'));
    expect(r.body.reminderScheduled).toBe(true);
    const usage = await createService(alfa, {
      name: 'API',
      billingPeriod: 'usage',
      renewsOn: inDays(10),
    });
    expect((await alfa.post(`/api/services/${usage.id}/renewed`)).status).toBe(409);
  });
});

describe('budżet', () => {
  it('przekroczenie: stan „exceeded” i jedno powiadomienie na miesiąc; faktura niższa niż raport cofa stan', async () => {
    const s = await createService(alfa, { monthlyBudget: '100' });
    await addCost(alfa, s.id, { kind: 'estimate', amount: '90' });
    expect((await alfa.get(`/api/services/${s.id}`)).body.current.budget.state).toBe('near');
    await addCost(alfa, s.id, { kind: 'report', amount: '120' });
    const d = (await alfa.get(`/api/services/${s.id}`)).body;
    expect(d.current.budget).toMatchObject({ state: 'exceeded', spentMicros: micros(120) });
    expect((await summary(alfa)).exceeded).toEqual([{ serviceId: s.id, name: 'VPS produkcja' }]);
    await addCost(alfa, s.id, { kind: 'report', amount: '10' });
    const notes = await t.db.owner.query(
      `SELECT user_id, title FROM notifications WHERE kind = 'budget'`,
    );
    expect(notes.rows).toEqual([
      { user_id: t.seed.users.alfa, title: 'Przekroczono budżet: VPS produkcja' },
    ]);
    await addCost(alfa, s.id, {
      kind: 'invoice',
      amount: '95',
      invoiceNumber: 'FV/B1',
      paidOn: inDays(0),
    });
    expect((await alfa.get(`/api/services/${s.id}`)).body.current.budget.state).toBe('near');
    // Prywatna usługa: Beta nic nie dostaje.
    expect(JSON.stringify((await beta.get('/api/notifications')).body)).not.toContain('budżet');
  });
});

describe('faktury: powtórny import nie dubluje', () => {
  const csv = [
    'numer;data_wystawienia;kwota;waluta;miesiac;data_zaplaty',
    `FV/2026/09/1;${month}-02;49,99;PLN;${month};${month}-05`,
    `FV/2026/09/2;${month}-10;10,00;PLN;${month};`,
    `FV/2026/08/7;${prevMonth}-03;49,99;PLN;${prevMonth};${prevMonth}-04`,
  ].join('\n');

  it('ten sam numer faktury (także z inną wielkością liter/spacjami) — odrzucony; CSV importowany raz', async () => {
    const s = await createService(alfa);
    expect(
      (
        await addCost(alfa, s.id, {
          kind: 'invoice',
          amount: '49,99',
          invoiceNumber: 'FV/2026/09/1',
        })
      ).status,
    ).toBe(201);
    const dup = await addCost(alfa, s.id, {
      kind: 'invoice',
      amount: '49,99',
      invoiceNumber: ' fv/2026/09/1 ',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('duplicate_invoice');

    const first = await alfa.post(`/api/services/${s.id}/costs/import`, { csv });
    expect(first.body).toEqual({ created: 2, duplicates: 1 });
    const again = await alfa.post(`/api/services/${s.id}/costs/import`, { csv });
    expect(again.body).toEqual({ created: 0, duplicates: 3 });
    const d = (await alfa.get(`/api/services/${s.id}?month=${month}`)).body;
    expect(d.entries.filter((e: any) => e.kind === 'invoice')).toHaveLength(3);
    expect(d.current.totals).toEqual([{ currency: 'PLN', micros: micros(59.99) }]);
    // Ten sam numer w innej usłudze jest inną fakturą.
    const other = await createService(alfa, { name: 'Kopie zapasowe', category: 'backup' });
    expect((await alfa.post(`/api/services/${other.id}/costs/import`, { csv })).body).toEqual({
      created: 3,
      duplicates: 0,
    });
  });

  it('faktura bez numeru: deduplikacja po dacie, kwocie i walucie; błędny CSV — nic nie importuje', async () => {
    const s = await createService(alfa);
    const inv = { kind: 'invoice', amount: '12', issuedOn: `${month}-03` };
    expect((await addCost(alfa, s.id, inv)).status).toBe(201);
    expect((await addCost(alfa, s.id, inv)).status).toBe(409);
    expect((await addCost(alfa, s.id, { ...inv, amount: '13' })).status).toBe(201);
    const bad = await alfa.post(`/api/services/${s.id}/costs/import`, {
      csv: `numer;kwota;waluta;miesiac\nA1;12;PLN;${month}\nA2;abc;PLN;${month}\nA3;5;XYZ;2026-13`,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details).toEqual([
      'Linia 3: nieprawidłowa kwota',
      'Linia 4: nieznana waluta „XYZ”',
      'Linia 4: miesiąc w formacie RRRR-MM',
    ]);
    const d = (await alfa.get(`/api/services/${s.id}`)).body;
    expect(d.entries.map((e: any) => e.invoiceNumber)).not.toContain('A1');
  });
});

describe('bez haseł i kluczy', () => {
  it('odrzuca pola wyglądające na sekrety i niebezpieczne linki do panelu', async () => {
    const bad: Array<Record<string, unknown>> = [
      { notes: 'hasło: Tajne123!' },
      { plan: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz' },
      { purpose: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123' },
      { panelUrl: 'https://admin:secret@panel.example.test/' },
      { panelUrl: 'http://panel.example.test/' },
      { panelUrl: 'https://panel.example.test/login?token=abc' },
      { panelUrl: 'javascript:alert(1)' },
    ];
    for (const over of bad) {
      const r = await alfa.post('/api/services', {
        name: 'X',
        category: 'other',
        billingPeriod: 'monthly',
        currency: 'PLN',
        ...over,
      });
      expect(r.status, JSON.stringify(over)).toBe(400);
    }
    const s = await createService(alfa);
    const cost = await addCost(alfa, s.id, {
      kind: 'estimate',
      amount: '1',
      description: 'api_key=abcdef123456',
    });
    expect(cost.status).toBe(400);
    expect((await alfa.get('/api/services')).body.items).toHaveLength(1);
  });
});

describe('adaptery raportów kosztów (atrapa)', () => {
  it('bez klucza: „niepodłączone” i brak synchronizacji', async () => {
    const plain = await createTestApp();
    try {
      const a = await login(plain.app, 'alfa');
      const items = (await a.get('/api/cost-adapters')).body.items;
      expect(items.map((i: any) => [i.id, i.state, i.keyConfigured])).toEqual([
        ['anthropic', 'not_configured', false],
        ['openai', 'not_configured', false],
      ]);
      const s = (
        await a.post('/api/services', {
          name: 'Claude',
          category: 'model_api',
          billingPeriod: 'usage',
          currency: 'USD',
          costAdapter: 'anthropic',
        })
      ).body;
      const sync = await a.post('/api/cost-adapters/anthropic/sync');
      expect(sync.status).toBe(409);
      expect(sync.body.error.code).toBe('not_configured');
      expect(s.costAdapter).toBe('anthropic');
    } finally {
      await plain.close();
    }
  });

  it('Anthropic: stronicowanie, centy jako tekst dziesiętny, jeden raport na miesiąc; ponowna synchronizacja aktualizuje', async () => {
    let items = (await alfa.get('/api/cost-adapters')).body.items;
    expect(items.find((i: any) => i.id === 'anthropic')).toMatchObject({
      keyConfigured: true,
      state: 'not_connected',
      serviceId: null,
    });
    expect(JSON.stringify(items)).not.toContain('TESTKEY');
    expect((await alfa.post('/api/cost-adapters/anthropic/sync')).body.error.code).toBe(
      'not_linked',
    );

    const s = await createService(alfa, {
      name: 'Claude API',
      category: 'model_api',
      billingPeriod: 'usage',
      currency: 'USD',
      costAdapter: 'anthropic',
      monthlyBudget: '10',
    });
    am.anthropicCents = [
      { day: `${prevMonth}-02`, amount: '1250.5' },
      { day: `${prevMonth}-02`, amount: '49.5' },
      { day: `${month}-01`, amount: '300' },
    ];
    const r = await alfa.post('/api/cost-adapters/anthropic/sync');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.months).toBe(2);
    const calls = am.calls.filter((c) => c.path.endsWith('/cost_report'));
    expect(calls.map((c) => c.query.page ?? null)).toEqual([null, 'p2']);
    expect(calls[0]!.query).toMatchObject({ bucket_width: '1d', limit: '31' });
    const d = (await alfa.get(`/api/services/${s.id}?month=${prevMonth}`)).body;
    expect(d.current).toMatchObject({
      countedKind: 'report',
      totals: [{ currency: 'USD', micros: 13_000_000 }],
    });
    expect(d.entries.map((e: any) => [e.month, e.kind, e.amountMicros, e.source])).toEqual([
      [month, 'report', 3_000_000, 'adapter:anthropic'],
      [prevMonth, 'report', 13_000_000, 'adapter:anthropic'],
    ]);
    items = (await alfa.get('/api/cost-adapters')).body.items;
    expect(items.find((i: any) => i.id === 'anthropic')).toMatchObject({
      state: 'connected',
      serviceId: s.id,
    });

    am.anthropicCents = [{ day: `${month}-01`, amount: '1500' }];
    await alfa.post('/api/cost-adapters/anthropic/sync');
    const after = (await alfa.get(`/api/services/${s.id}`)).body;
    expect(after.entries.filter((e: any) => e.month === month)).toHaveLength(1);
    expect(after.current.totals).toEqual([{ currency: 'USD', micros: 15_000_000 }]);
    expect(after.current.budget.state).toBe('exceeded');
    // Faktura za miesiąc zastępuje raport w sumie.
    await addCost(alfa, s.id, {
      kind: 'invoice',
      amount: '14,5',
      currency: 'USD',
      invoiceNumber: 'ANT-1',
    });
    expect((await alfa.get(`/api/services/${s.id}`)).body.current.countedKind).toBe('invoice');

    // Błąd klucza => „błąd” (nadal niepodłączone), komunikat bez klucza.
    am.mode = 'unauthorized';
    const fail = await alfa.post('/api/cost-adapters/anthropic/sync');
    expect(fail.status).toBe(502);
    items = (await alfa.get('/api/cost-adapters')).body.items;
    expect(items.find((i: any) => i.id === 'anthropic')).toMatchObject({
      state: 'error',
      lastError: expect.stringContaining('klucz administracyjny odrzucony'),
    });
    const dump = await t.db.owner.query(
      `SELECT (SELECT string_agg(details::text, ' ') FROM audit_log) AS a,
              (SELECT string_agg(last_error, ' ') FROM cost_adapter_runs) AS r`,
    );
    expect(JSON.stringify(dump.rows)).not.toContain('TESTKEY');
  });

  it('OpenAI: kwoty w dolarach, nagłówek Bearer; synchronizuje tylko właściciel usługi', async () => {
    const s = await createService(alfa, {
      name: 'OpenAI API',
      category: 'model_api',
      billingPeriod: 'usage',
      currency: 'USD',
      costAdapter: 'openai',
      space: 'shared',
    });
    am.openaiDollars = [
      { day: `${month}-01`, value: 4.25 },
      { day: `${month}-01`, value: 0.130804 },
    ];
    expect((await beta.post('/api/cost-adapters/openai/sync')).status).toBe(403);
    const r = await alfa.post('/api/cost-adapters/openai/sync');
    expect(r.status).toBe(200);
    const call = am.calls.find((c) => c.path.endsWith('/organization/costs'))!;
    expect(call.query).toMatchObject({ bucket_width: '1d' });
    expect(Number(call.query.start_time)).toBe(Date.parse(`${prevMonth}-01T00:00:00Z`) / 1000);
    const d = (await beta.get(`/api/services/${s.id}`)).body;
    expect(d.current.totals).toEqual([{ currency: 'USD', micros: 4_380_804 }]);
  });

  it('przeliczenie kwot raportu na mikro-jednostki', () => {
    expect(decimalToMicros('123.78912', 10_000)).toBe(1_237_891);
    expect(decimalToMicros('0.00005', 10_000)).toBe(1);
    expect(decimalToMicros('300', 10_000)).toBe(3_000_000);
  });
});
