import type pg from 'pg';
import { withSystemTx, type Db } from '../db/pool';
import { emitEvent } from '../events';

/** Budżet liczony w miesiącu kalendarzowym strefy domowników. */
const BUDGET_TZ = 'Europe/Warsaw';
const MONTH_START = `date_trunc('month', now() AT TIME ZONE '${BUDGET_TZ}') AT TIME ZONE '${BUDGET_TZ}'`;

export class BudgetBlocked extends Error {
  constructor(public readonly reason: 'paid_calls_disabled' | 'hard_limit') {
    super(
      reason === 'hard_limit' ? 'Osiągnięto twardy limit budżetu' : 'Płatne wywołania są wyłączone',
    );
  }
}

interface BudgetRow {
  currency: string;
  soft_limit_micros: number | null;
  hard_limit_micros: number | null;
  paid_calls_enabled: boolean;
}

interface BudgetStatus {
  currency: string;
  period: string;
  spent: number;
  estimatedShare: number;
  softLimit: number | null;
  hardLimit: number | null;
  state: 'ok' | 'warning' | 'blocked';
  paidCallsEnabled: boolean;
  byProvider: Array<{
    provider: string;
    model: string;
    cost: number;
    calls: number;
    estimated: boolean;
  }>;
}

const toUnits = (micros: number | null) => (micros === null ? null : micros / 1_000_000);
const toMicros = (units: number) => Math.round(units * 1_000_000);

function stateOf(b: BudgetRow, spentMicros: number): BudgetStatus['state'] {
  if (!b.paid_calls_enabled) return 'blocked';
  if (b.hard_limit_micros !== null && spentMicros >= b.hard_limit_micros) return 'blocked';
  if (b.soft_limit_micros !== null && spentMicros >= b.soft_limit_micros) return 'warning';
  return 'ok';
}

interface ReserveArgs {
  householdId: string;
  userId: string | null;
  taskId?: string | null;
  conversationId?: string | null;
  provider: string;
  model: string;
  capability: string;
  paid: boolean;
  worstCaseMicros: number;
  priceSource?: string | null;
}

/**
 * Egzekwowanie budżetu: rezerwacja najgorszego przypadku pod blokadą doradczą per dom,
 * rozliczenie rzeczywistym kosztem po odpowiedzi. Przekroczenie twardego limitu jest niemożliwe
 * także przy równoległych wywołaniach.
 */
export class BudgetService {
  constructor(
    private readonly db: Db,
    private readonly currency: string,
  ) {}

  private async row(c: pg.PoolClient | pg.Pool, householdId: string): Promise<BudgetRow> {
    const r = await c.query<BudgetRow>(
      `SELECT currency, soft_limit_micros, hard_limit_micros, paid_calls_enabled FROM budgets WHERE household_id = $1`,
      [householdId],
    );
    return (
      r.rows[0] ?? {
        currency: this.currency,
        soft_limit_micros: null,
        hard_limit_micros: null,
        paid_calls_enabled: true,
      }
    );
  }

  private async spent(c: pg.PoolClient | pg.Pool, householdId: string): Promise<number> {
    const r = await c.query<{ sum: string | null }>(
      `SELECT sum(cost_micros)::text AS sum FROM usage_records
        WHERE household_id = $1 AND status IN ('reserved','final') AND created_at >= ${MONTH_START}`,
      [householdId],
    );
    return Number(r.rows[0]?.sum ?? 0);
  }

  async status(householdId: string): Promise<BudgetStatus> {
    const b = await this.row(this.db.owner, householdId);
    const spent = await this.spent(this.db.owner, householdId);
    const agg = await this.db.owner.query<{
      provider: string;
      model: string;
      cost: string;
      calls: number;
      estimated: boolean;
      est_cost: string;
    }>(
      `SELECT provider, model, sum(cost_micros)::text AS cost, count(*)::int AS calls, bool_or(estimated) AS estimated,
              sum(CASE WHEN estimated THEN cost_micros ELSE 0 END)::text AS est_cost
         FROM usage_records
        WHERE household_id = $1 AND status IN ('reserved','final') AND created_at >= ${MONTH_START}
        GROUP BY provider, model ORDER BY sum(cost_micros) DESC`,
      [householdId],
    );
    const period = await this.db.owner.query<{ p: string }>(
      `SELECT to_char(now() AT TIME ZONE '${BUDGET_TZ}', 'YYYY-MM') AS p`,
    );
    return {
      currency: b.currency,
      period: period.rows[0]!.p,
      spent: spent / 1_000_000,
      estimatedShare: agg.rows.reduce((n, r) => n + Number(r.est_cost), 0) / 1_000_000,
      softLimit: toUnits(b.soft_limit_micros),
      hardLimit: toUnits(b.hard_limit_micros),
      state: stateOf(b, spent),
      paidCallsEnabled: b.paid_calls_enabled,
      byProvider: agg.rows.map((r) => ({
        provider: r.provider,
        model: r.model,
        cost: Number(r.cost) / 1_000_000,
        calls: r.calls,
        estimated: r.estimated,
      })),
    };
  }

  async reserve(a: ReserveArgs): Promise<string> {
    return withSystemTx(this.db, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('nova_budget:' || $1))`, [
        a.householdId,
      ]);
      if (a.paid) {
        const b = await this.row(c, a.householdId);
        const spent = await this.spent(c, a.householdId);
        const blocked = !b.paid_calls_enabled
          ? 'paid_calls_disabled'
          : b.hard_limit_micros !== null && spent + a.worstCaseMicros > b.hard_limit_micros
            ? 'hard_limit'
            : null;
        if (blocked) {
          await emitEvent(c, {
            householdId: a.householdId,
            ownerUserId: a.userId,
            visibility: 'shared',
            type: 'budget.blocked',
            payload: { reason: blocked },
          });
          // Zdarzenie musi przetrwać — zatwierdzamy transakcję, a błąd zgłaszamy po niej.
          return `blocked:${blocked}`;
        }
      }
      const r = await c.query<{ id: string }>(
        `INSERT INTO usage_records (household_id, owner_user_id, task_id, conversation_id, provider, model, capability,
           status, cost_micros, currency, paid, price_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'reserved',$8,$9,$10,$11) RETURNING id`,
        [
          a.householdId,
          a.userId,
          a.taskId ?? null,
          a.conversationId ?? null,
          a.provider,
          a.model,
          a.capability,
          a.paid ? a.worstCaseMicros : 0,
          this.currency,
          a.paid,
          a.priceSource ?? null,
        ],
      );
      return r.rows[0]!.id;
    }).then((id) => {
      if (id.startsWith('blocked:'))
        throw new BudgetBlocked(id.slice(8) as BudgetBlocked['reason']);
      return id;
    });
  }

  /** Rozliczenie rzeczywistym kosztem. Zwraca, czy przekroczono próg ostrzeżenia tym wywołaniem. */
  async settle(
    id: string,
    s: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      costMicros: number;
      estimated: boolean;
    },
  ): Promise<{ crossedSoft: boolean }> {
    return withSystemTx(this.db, async (c) => {
      const cur = await c.query<{ household_id: string; owner_user_id: string | null }>(
        `SELECT household_id, owner_user_id FROM usage_records WHERE id = $1`,
        [id],
      );
      const hh = cur.rows[0]?.household_id;
      if (!hh) return { crossedSoft: false };
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('nova_budget:' || $1))`, [hh]);
      const b = await this.row(c, hh);
      const wasBelow =
        b.soft_limit_micros !== null && (await this.wasBelowSoft(c, hh, id, b.soft_limit_micros));
      await c.query(
        `UPDATE usage_records SET status = 'final', input_tokens = $2, output_tokens = $3, cache_read_tokens = $4,
                cache_write_tokens = $5, cost_micros = $6, estimated = $7, settled_at = now()
          WHERE id = $1 AND status = 'reserved'`,
        [
          id,
          s.inputTokens,
          s.outputTokens,
          s.cacheReadTokens,
          s.cacheWriteTokens,
          s.costMicros,
          s.estimated,
        ],
      );
      const after = await this.spent(c, hh);
      // Ostrzeżenie emitujemy raz: gdy to wywołanie przeprowadza wydatki przez próg.
      const crossedSoft = wasBelow && b.soft_limit_micros !== null && after >= b.soft_limit_micros;
      if (crossedSoft) {
        await emitEvent(c, {
          householdId: hh,
          ownerUserId: cur.rows[0]!.owner_user_id,
          visibility: 'shared',
          type: 'budget.warning',
          payload: { spent: after / 1_000_000, softLimit: b.soft_limit_micros! / 1_000_000 },
        });
      }
      return { crossedSoft };
    });
  }

  private async wasBelowSoft(
    c: pg.PoolClient,
    hh: string,
    excludeId: string,
    soft: number,
  ): Promise<boolean> {
    const r = await c.query<{ sum: string | null }>(
      `SELECT sum(cost_micros)::text AS sum FROM usage_records
        WHERE household_id = $1 AND id <> $2 AND status IN ('reserved','final') AND created_at >= ${MONTH_START}`,
      [hh, excludeId],
    );
    return Number(r.rows[0]?.sum ?? 0) < soft;
  }

  async fail(id: string, costMicros = 0): Promise<void> {
    await this.db.owner.query(
      `UPDATE usage_records SET status = 'failed', cost_micros = $2, settled_at = now() WHERE id = $1 AND status = 'reserved'`,
      [id, costMicros],
    );
  }

  async update(
    householdId: string,
    userId: string,
    u: { softLimit: number | null; hardLimit: number | null; paidCallsEnabled: boolean },
  ): Promise<void> {
    await withSystemTx(this.db, async (c) => {
      await c.query(
        `INSERT INTO budgets (household_id, currency, soft_limit_micros, hard_limit_micros, paid_calls_enabled, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (household_id) DO UPDATE SET currency = EXCLUDED.currency,
           soft_limit_micros = EXCLUDED.soft_limit_micros, hard_limit_micros = EXCLUDED.hard_limit_micros,
           paid_calls_enabled = EXCLUDED.paid_calls_enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [
          householdId,
          this.currency,
          u.softLimit === null ? null : toMicros(u.softLimit),
          u.hardLimit === null ? null : toMicros(u.hardLimit),
          u.paidCallsEnabled,
          userId,
        ],
      );
      await emitEvent(c, {
        householdId,
        ownerUserId: userId,
        visibility: 'shared',
        type: 'budget.changed',
        payload: { paidCallsEnabled: u.paidCallsEnabled },
      });
    });
  }
}
