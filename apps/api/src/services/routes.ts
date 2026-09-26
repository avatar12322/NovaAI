import {
  CreateCost,
  CreateService,
  currencyDigits,
  currentMonth,
  ImportCosts,
  isCurrency,
  ListServicesQuery,
  looksLikeSecret,
  parseAmountMicros,
  SummaryQuery,
  UpdateService,
  type CostAdapterId,
  type CostAdapterInfo,
  type CostSummary,
  type Money,
  type ServiceMonth,
} from '@nova/contracts';
import { decideCreate } from '@nova/permissions';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { actorFor, authorize, requireAuth } from '../access';
import { writeAudit } from '../audit';
import { withUserTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors';
import { parse } from '../lib/validate';
import { CostAdapterError } from './adapters';
import {
  dedupeKey,
  entriesFor,
  monthsFor,
  nextRenewal,
  notifyBudget,
  panelUrlOrNull,
  parseInvoiceCsv,
  SERVICE_SELECT,
  syncReminder,
  toServiceInfo,
  type ServiceRow,
} from './service';

const DetailQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
});

const UNIQUE_MSG: Record<string, string> = {
  services_model_provider_uq:
    'Ten dostawca modeli jest już przypisany do innej usługi w domu — jego koszt liczymy tylko raz.',
  services_cost_adapter_uq:
    'Ten adapter kosztów jest już przypisany do innej usługi w domu — raport liczymy tylko raz.',
};

/** Naruszenie unikalności dostawcy/adaptera => 409 bez ujawniania, czyja to usługa. */
function mapUnique(e: unknown): never {
  const c = (e as { code?: string; constraint?: string }).constraint;
  if ((e as { code?: string }).code === '23505' && c && UNIQUE_MSG[c])
    throw conflict('already_linked', UNIQUE_MSG[c]);
  throw e;
}

/** Nie więcej miejsc po przecinku, niż ma waluta (JPY 0, PLN 2) — wpisy ręczne i budżet. */
function checkDigits(amount: string | null | undefined, currency: string) {
  if (!amount) return;
  const dec = amount.split(/[.,]/)[1]?.length ?? 0;
  const digits = currencyDigits(currency);
  if (dec > digits)
    throw badRequest(
      digits === 0
        ? `Kwoty w ${currency} nie mają części ułamkowej`
        : `Kwota w ${currency}: najwyżej ${digits} miejsca po przecinku`,
    );
}

const budgetMicros = (text: string | null | undefined) => {
  if (text === undefined) return undefined;
  if (text === null) return null;
  return parseAmountMicros(text);
};

export const serviceRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const audit = (
      req: FastifyRequest,
      action: string,
      id: string,
      ownerUserId: string,
      householdId: string | null,
      details?: Record<string, unknown>,
    ) =>
      writeAudit(deps.db, {
        actorKind: 'user',
        actorUserId: req.auth!.userId,
        ownerUserId,
        householdId,
        source: 'api',
        action,
        resourceType: 'service',
        resourceId: id,
        outcome: 'ok',
        correlationId: req.id,
        details,
      });

    const rowsFor = async (
      c: pg.PoolClient,
      space: 'private' | 'shared' | 'all',
      householdId: string | null,
    ): Promise<ServiceRow[]> => {
      const own = `(s.visibility = 'private' AND s.owner_user_id = nova_uid())`;
      const shared = `(s.visibility = 'shared' AND s.household_id = $1)`;
      const where =
        space === 'private' ? own : space === 'shared' ? shared : `(${own} OR ${shared})`;
      const r = await c.query<ServiceRow>(
        `${SERVICE_SELECT} WHERE ${where} ORDER BY s.name, s.id`,
        [householdId],
      );
      return r.rows;
    };
    const rowById = async (c: pg.PoolClient, id: string): Promise<ServiceRow> => {
      const r = await c.query<ServiceRow>(`${SERVICE_SELECT} WHERE s.id = $1`, [id]);
      if (!r.rows[0]) throw notFound('Service');
      return r.rows[0];
    };
    const info = async (c: pg.PoolClient, row: ServiceRow, userId: string, month: string) => {
      const m = (await monthsFor(c, [row], month)).get(row.id)!;
      return toServiceInfo(row, userId, m);
    };
    const userTx = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
      withUserTx(deps.db, { userId, scope: 'user' }, fn);

    /** Po zmianie kosztów: stan miesiąca i ewentualne powiadomienie o przekroczeniu budżetu. */
    const afterCostChange = async (userId: string, serviceId: string, months: Iterable<string>) => {
      for (const month of new Set(months)) {
        const { row, state } = await userTx(userId, async (c) => {
          const row = await rowById(c, serviceId);
          return { row, state: (await monthsFor(c, [row], month)).get(serviceId)! };
        });
        await notifyBudget(deps.db, row, state);
      }
    };

    app.get('/services', async (req) => {
      const auth = requireAuth(req);
      const q = parse(ListServicesQuery, req.query);
      const month = q.month ?? currentMonth();
      const items = await userTx(auth.userId, async (c) => {
        const rows = await rowsFor(c, q.space, auth.householdId);
        const months = await monthsFor(c, rows, month);
        return rows.map((r) => toServiceInfo(r, auth.userId, months.get(r.id)!));
      });
      return { month, items };
    });

    app.get('/costs/summary', async (req): Promise<CostSummary> => {
      const auth = requireAuth(req);
      const q = parse(SummaryQuery, req.query);
      const month = q.month ?? currentMonth();
      return userTx(auth.userId, async (c) => {
        const rows = await rowsFor(c, q.space, auth.householdId);
        const months = await monthsFor(c, rows, month);
        const totals: Money[] = [];
        const byKind: CostSummary['byKind'] = [];
        const add = (kind: CostSummary['byKind'][number]['kind'], m: Money) => {
          if (!m.micros) return;
          const cur = byKind.find((x) => x.kind === kind && x.currency === m.currency);
          if (cur) cur.micros += m.micros;
          else byKind.push({ kind, ...m });
        };
        const exceeded: CostSummary['exceeded'] = [];
        for (const r of rows) {
          const m = months.get(r.id)!;
          for (const t of m.totals) {
            const tot = totals.find((x) => x.currency === t.currency);
            if (tot) tot.micros += t.micros;
            else totals.push({ ...t });
            if (m.countedKind === 'invoice') {
              const unpaid = m.invoiceUnpaid.find((u) => u.currency === t.currency)?.micros ?? 0;
              add('invoice', { currency: t.currency, micros: t.micros - unpaid });
              add('invoice_unpaid', { currency: t.currency, micros: unpaid });
            } else if (m.countedKind) add(m.countedKind, t);
          }
          if (m.budget?.state === 'exceeded') exceeded.push({ serviceId: r.id, name: r.name });
        }
        const order = ['invoice', 'invoice_unpaid', 'report', 'estimate'];
        totals.sort((a, b) => a.currency.localeCompare(b.currency));
        byKind.sort(
          (a, b) =>
            order.indexOf(a.kind) - order.indexOf(b.kind) || a.currency.localeCompare(b.currency),
        );
        return { month, totals, byKind, exceeded, services: rows.length };
      });
    });

    app.post('/services', async (req, reply) => {
      const auth = requireAuth(req);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      const body = parse(CreateService, req.body);
      checkDigits(body.monthlyBudget, body.currency);
      const d = decideCreate(actorFor(auth), 'service.create', {
        householdId: auth.householdId,
        visibility: body.space,
      });
      if (!d.allow) throw forbidden();
      const created = await userTx(auth.userId, async (c) => {
        let id: string;
        try {
          const r = await c.query<{ id: string }>(
            `INSERT INTO services (household_id, owner_user_id, visibility, name, category, purpose, panel_url,
               billing_period, currency, plan, renews_on, renewal_anchor_day, remind_days_before,
               monthly_budget_micros, status, model_provider, cost_adapter, notes)
             VALUES ($1, nova_uid(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
             RETURNING id`,
            [
              auth.householdId,
              body.space,
              body.name,
              body.category,
              body.purpose,
              panelUrlOrNull(body.panelUrl),
              body.billingPeriod,
              body.currency,
              body.plan,
              body.renewsOn,
              body.renewsOn ? Number(body.renewsOn.slice(8, 10)) : null,
              body.remindDaysBefore,
              budgetMicros(body.monthlyBudget),
              body.status,
              body.modelProvider,
              body.costAdapter,
              body.notes,
            ],
          );
          id = r.rows[0]!.id;
        } catch (e) {
          mapUnique(e);
        }
        const warning = await syncReminder(c, await rowById(c, id));
        return { row: await rowById(c, id), warning };
      });
      await audit(req, 'service.create', created.row.id, auth.userId, auth.householdId, {
        visibility: body.space,
        category: body.category,
      });
      const service = await userTx(auth.userId, (c) =>
        info(c, created.row, auth.userId, currentMonth()),
      );
      return reply
        .status(201)
        .send({ ...service, warnings: created.warning ? [created.warning] : [] });
    });

    app.get<{ Params: { id: string } }>('/services/:id', async (req) => {
      const auth = requireAuth(req);
      await authorize(deps.db, req, 'service', req.params.id, 'service.read');
      const q = parse(DetailQuery, req.query);
      const month = q.month ?? currentMonth();
      return userTx(auth.userId, async (c) => {
        const row = await rowById(c, req.params.id);
        return {
          ...(await info(c, row, auth.userId, month)),
          entries: await entriesFor(c, row.id),
        };
      });
    });

    app.patch<{ Params: { id: string } }>('/services/:id', async (req) => {
      const auth = requireAuth(req);
      const meta = await authorize(deps.db, req, 'service', req.params.id, 'service.manage');
      const body = parse(UpdateService, req.body);
      if (body.monthlyBudget) {
        const cur =
          body.currency ??
          (
            await deps.db.owner.query<{ currency: string }>(
              `SELECT currency FROM services WHERE id = $1`,
              [req.params.id],
            )
          ).rows[0]?.currency;
        if (cur) checkDigits(body.monthlyBudget, cur);
      }
      const cols: Record<string, unknown> = {
        name: body.name,
        category: body.category,
        purpose: body.purpose,
        panel_url: body.panelUrl === undefined ? undefined : panelUrlOrNull(body.panelUrl),
        billing_period: body.billingPeriod,
        currency: body.currency,
        plan: body.plan,
        renews_on: body.renewsOn,
        renewal_anchor_day:
          body.renewsOn === undefined
            ? undefined
            : body.renewsOn
              ? Number(body.renewsOn.slice(8, 10))
              : null,
        remind_days_before: body.remindDaysBefore,
        monthly_budget_micros: budgetMicros(body.monthlyBudget),
        status: body.status,
        model_provider: body.modelProvider,
        cost_adapter: body.costAdapter,
        notes: body.notes,
      };
      const set = Object.entries(cols).filter(([, v]) => v !== undefined);
      const reschedule = ['renewsOn', 'remindDaysBefore', 'status', 'name', 'plan'].some(
        (k) => k in body,
      );
      const res = await userTx(auth.userId, async (c) => {
        if (set.length) {
          try {
            await c.query(
              `UPDATE services SET ${set.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now()
                WHERE id = $1`,
              [req.params.id, ...set.map(([, v]) => v)],
            );
          } catch (e) {
            mapUnique(e);
          }
        }
        const warning = reschedule ? await syncReminder(c, await rowById(c, req.params.id)) : null;
        const row = await rowById(c, req.params.id);
        return {
          ...(await info(c, row, auth.userId, currentMonth())),
          warnings: warning ? [warning] : [],
        };
      });
      await audit(req, 'service.update', req.params.id, meta.ownerUserId, meta.householdId, {
        fields: set.map(([k]) => k),
      });
      return res;
    });

    app.delete<{ Params: { id: string } }>('/services/:id', async (req) => {
      const auth = requireAuth(req);
      const meta = await authorize(deps.db, req, 'service', req.params.id, 'service.manage');
      await userTx(auth.userId, async (c) => {
        const row = await rowById(c, req.params.id);
        if (row.reminder_id)
          await c.query(
            `UPDATE reminders SET status = 'cancelled', cancelled_at = now() WHERE id = $1 AND status = 'scheduled'`,
            [row.reminder_id],
          );
        const r = await c.query('DELETE FROM services WHERE id = $1', [req.params.id]);
        if (r.rowCount !== 1) throw notFound('Service');
      });
      await audit(req, 'service.delete', req.params.id, meta.ownerUserId, meta.householdId);
      return { ok: true };
    });

    for (const [path, visibility, action] of [
      ['share', 'shared', 'service.share'],
      ['unshare', 'private', 'service.unshare'],
    ] as const) {
      app.post<{ Params: { id: string } }>(`/services/:id/${path}`, async (req) => {
        const auth = requireAuth(req);
        const meta = await authorize(deps.db, req, 'service', req.params.id, action);
        const res = await userTx(auth.userId, async (c) => {
          await c.query(`UPDATE services SET visibility = $2, updated_at = now() WHERE id = $1`, [
            req.params.id,
            visibility,
          ]);
          // Przypomnienie zmienia odbiorców razem z usługą.
          const warning = await syncReminder(c, await rowById(c, req.params.id));
          const row = await rowById(c, req.params.id);
          return {
            ...(await info(c, row, auth.userId, currentMonth())),
            warnings: warning ? [warning] : [],
          };
        });
        await audit(req, action, req.params.id, meta.ownerUserId, meta.householdId);
        return res;
      });
    }

    /** „Odnowiono”: następna data według okresu rozliczeniowego i nowe przypomnienie. */
    app.post<{ Params: { id: string } }>('/services/:id/renewed', async (req) => {
      const auth = requireAuth(req);
      const meta = await authorize(deps.db, req, 'service', req.params.id, 'service.manage');
      const res = await userTx(auth.userId, async (c) => {
        const row = await rowById(c, req.params.id);
        if (!row.renews_on) throw conflict('no_renewal', 'Usługa nie ma daty odnowienia');
        const next = nextRenewal(
          row.renews_on,
          row.renewal_anchor_day ?? Number(row.renews_on.slice(8, 10)),
          row.billing_period,
        );
        if (!next)
          throw conflict(
            'no_period',
            'Dla usług jednorazowych i rozliczanych za użycie ustaw datę ręcznie',
          );
        await c.query(`UPDATE services SET renews_on = $2, updated_at = now() WHERE id = $1`, [
          row.id,
          next,
        ]);
        const warning = await syncReminder(c, await rowById(c, row.id));
        return {
          ...(await info(c, await rowById(c, row.id), auth.userId, currentMonth())),
          warnings: warning ? [warning] : [],
        };
      });
      await audit(req, 'service.renewed', req.params.id, meta.ownerUserId, meta.householdId, {
        renewsOn: res.renewsOn,
      });
      return res;
    });

    app.post<{ Params: { id: string } }>('/services/:id/costs', async (req, reply) => {
      const auth = requireAuth(req);
      const meta = await authorize(deps.db, req, 'service', req.params.id, 'service.manage');
      const body = parse(CreateCost, req.body);
      checkDigits(body.amount, body.currency);
      const amount = parseAmountMicros(body.amount)!;
      const entry = await userTx(auth.userId, async (c) => {
        const r = await c.query<{ id: string }>(
          `INSERT INTO service_costs (service_id, kind, month, amount_micros, currency, description, invoice_number,
             issued_on, paid_on, source, dedupe_key, created_by)
           VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, 'manual', $10, nova_uid())
           ON CONFLICT (service_id, dedupe_key) DO NOTHING RETURNING id`,
          [
            req.params.id,
            body.kind,
            `${body.month}-01`,
            amount,
            body.currency,
            body.description,
            body.invoiceNumber ?? null,
            body.issuedOn ?? null,
            body.paidOn ?? null,
            dedupeKey({ ...body, amountMicros: amount }),
          ],
        );
        if (!r.rows[0])
          throw conflict(
            'duplicate_invoice',
            body.invoiceNumber
              ? `Faktura nr ${body.invoiceNumber} jest już zapisana dla tej usługi`
              : 'Ta faktura (data, kwota, waluta) jest już zapisana dla tej usługi',
          );
        return r.rows[0].id;
      });
      await audit(req, 'service.cost_add', req.params.id, meta.ownerUserId, meta.householdId, {
        kind: body.kind,
        month: body.month,
      });
      await afterCostChange(auth.userId, req.params.id, [body.month]);
      return reply.status(201).send({ id: entry });
    });

    app.delete<{ Params: { id: string; costId: string } }>(
      '/services/:id/costs/:costId',
      async (req) => {
        const auth = requireAuth(req);
        const meta = await authorize(deps.db, req, 'service', req.params.id, 'service.manage');
        await userTx(auth.userId, async (c) => {
          const r = await c.query(`DELETE FROM service_costs WHERE id = $1 AND service_id = $2`, [
            req.params.costId,
            req.params.id,
          ]);
          if (r.rowCount !== 1) throw notFound('Cost');
        });
        await audit(req, 'service.cost_delete', req.params.id, meta.ownerUserId, meta.householdId);
        return { ok: true };
      },
    );

    /** Import faktur z CSV. Powtórny import tych samych faktur niczego nie dubluje (klucz deduplikacji). */
    app.post<{ Params: { id: string } }>('/services/:id/costs/import', async (req) => {
      const auth = requireAuth(req);
      const meta = await authorize(deps.db, req, 'service', req.params.id, 'service.manage');
      const body = parse(ImportCosts, req.body);
      const { rows, errors } = parseInvoiceCsv(body.csv, {
        currency: isCurrency,
        secret: looksLikeSecret,
      });
      if (errors.length)
        throw new HttpError(400, 'invalid_csv', 'Import przerwany — popraw plik', errors);
      const created = await userTx(auth.userId, async (c) => {
        let n = 0;
        for (const r of rows) {
          const ins = await c.query(
            `INSERT INTO service_costs (service_id, kind, month, amount_micros, currency, description, invoice_number,
               issued_on, paid_on, source, dedupe_key, created_by)
             VALUES ($1, 'invoice', $2::date, $3, $4, $5, $6, $7, $8, 'import', $9, nova_uid())
             ON CONFLICT (service_id, dedupe_key) DO NOTHING`,
            [
              req.params.id,
              `${r.month}-01`,
              r.amountMicros,
              r.currency,
              r.description,
              r.invoiceNumber,
              r.issuedOn,
              r.paidOn,
              dedupeKey({ kind: 'invoice', ...r }),
            ],
          );
          n += ins.rowCount ?? 0;
        }
        return n;
      });
      await audit(req, 'service.cost_import', req.params.id, meta.ownerUserId, meta.householdId, {
        rows: rows.length,
        created,
      });
      await afterCostChange(
        auth.userId,
        req.params.id,
        rows.map((r) => r.month),
      );
      return { created, duplicates: rows.length - created };
    });

    // ---------- Adaptery kosztów dostawców ----------

    const adapterInfo = async (
      householdId: string | null,
      userId: string,
    ): Promise<CostAdapterInfo[]> => {
      const runs = householdId
        ? await deps.db.owner.query<{
            adapter: string;
            last_attempt_at: string | null;
            last_success_at: string | null;
            last_error: string | null;
          }>(
            `SELECT adapter, last_attempt_at, last_success_at, last_error FROM cost_adapter_runs WHERE household_id = $1`,
            [householdId],
          )
        : { rows: [] };
      const linked = await userTx(userId, (c) =>
        c.query<{ id: string; cost_adapter: CostAdapterId }>(
          `SELECT id, cost_adapter FROM services WHERE cost_adapter IS NOT NULL`,
        ),
      );
      return [...deps.costAdapters.values()].map((a) => {
        const run = runs.rows.find((r) => r.adapter === a.id);
        const ok =
          !!run?.last_success_at &&
          (!run.last_attempt_at ||
            Date.parse(run.last_success_at) >= Date.parse(run.last_attempt_at));
        return {
          id: a.id,
          title: a.title,
          docsUrl: a.docsUrl,
          docsVerifiedAt: a.docsVerifiedAt,
          keyConfigured: a.keyConfigured(),
          state: !a.keyConfigured()
            ? 'not_configured'
            : ok
              ? 'connected'
              : run?.last_error
                ? 'error'
                : 'not_connected',
          lastAttemptAt: run?.last_attempt_at ?? null,
          lastSuccessAt: run?.last_success_at ?? null,
          lastError: run?.last_error ?? null,
          serviceId: linked.rows.find((s) => s.cost_adapter === a.id)?.id ?? null,
        };
      });
    };

    app.get('/cost-adapters', async (req) => {
      const auth = requireAuth(req);
      return { items: await adapterInfo(auth.householdId, auth.userId) };
    });

    /**
     * Synchronizacja raportu dostawcy do usługi z przypisanym adapterem (tylko jej właściciel): koszty dzienne
     * z poprzedniego i bieżącego miesiąca, jeden wpis „raport dostawcy” na miesiąc i walutę (aktualizowany).
     */
    app.post<{ Params: { id: string } }>('/cost-adapters/:id/sync', async (req) => {
      const auth = requireAuth(req);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      const adapter = deps.costAdapters.get(req.params.id as CostAdapterId);
      if (!adapter) throw notFound('Adapter');
      const service = await userTx(auth.userId, (c) =>
        c.query<{ id: string; owner_user_id: string }>(
          `SELECT id, owner_user_id FROM services WHERE cost_adapter = $1 AND household_id = $2`,
          [adapter.id, auth.householdId],
        ),
      );
      const target = service.rows[0];
      if (!target)
        throw conflict(
          'not_linked',
          'Najpierw przypisz ten adapter do swojej usługi (edycja usługi)',
        );
      await authorize(deps.db, req, 'service', target.id, 'service.manage');
      if (!adapter.keyConfigured())
        throw conflict(
          'not_configured',
          'Adapter niepodłączony: brak klucza administracyjnego w konfiguracji serwera',
        );
      const now = new Date();
      const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const record = (ok: boolean, error: string | null) =>
        deps.db.owner.query(
          `INSERT INTO cost_adapter_runs (household_id, adapter, last_attempt_at, last_success_at, last_error)
           VALUES ($1, $2, now(), CASE WHEN $3 THEN now() END, $4)
           ON CONFLICT (household_id, adapter) DO UPDATE SET last_attempt_at = now(),
             last_success_at = CASE WHEN $3 THEN now() ELSE cost_adapter_runs.last_success_at END,
             last_error = $4`,
          [auth.householdId, adapter.id, ok, error],
        );
      let days;
      try {
        days = await adapter.fetchDaily(from, now);
      } catch (e) {
        const msg = e instanceof CostAdapterError ? e.message : 'nieoczekiwany błąd';
        await record(false, msg.slice(0, 300));
        await audit(
          req,
          'service.adapter_sync',
          target.id,
          target.owner_user_id,
          auth.householdId,
          {
            adapter: adapter.id,
            ok: false,
          },
        );
        throw new HttpError(502, 'adapter_error', `Synchronizacja nieudana: ${msg}`);
      }
      const perMonth = new Map<string, Money>();
      for (const d of days) {
        const key = `${d.day.slice(0, 7)}|${d.currency}`;
        const cur = perMonth.get(key);
        if (cur) cur.micros += d.amountMicros;
        else perMonth.set(key, { currency: d.currency, micros: d.amountMicros });
      }
      await userTx(auth.userId, async (c) => {
        for (const [key, m] of perMonth) {
          const month = key.slice(0, 7);
          await c.query(
            `INSERT INTO service_costs (service_id, kind, month, amount_micros, currency, description, source,
               dedupe_key, created_by)
             VALUES ($1, 'report', $2::date, $3, $4, $5, $6, $7, nova_uid())
             ON CONFLICT (service_id, dedupe_key) DO UPDATE SET amount_micros = EXCLUDED.amount_micros,
               updated_at = now()`,
            [
              target.id,
              `${month}-01`,
              m.micros,
              m.currency,
              `Raport kosztów dostawcy (${adapter.id}, synchronizacja)`,
              `adapter:${adapter.id}`,
              `adapter:${adapter.id}:${month}:${m.currency}`,
            ],
          );
        }
      });
      await record(true, null);
      await audit(req, 'service.adapter_sync', target.id, target.owner_user_id, auth.householdId, {
        adapter: adapter.id,
        ok: true,
        months: perMonth.size,
      });
      await afterCostChange(
        auth.userId,
        target.id,
        [...perMonth.keys()].map((k) => k.slice(0, 7)),
      );
      return { months: perMonth.size, items: await adapterInfo(auth.householdId, auth.userId) };
    });
  };

export type { ServiceMonth };
