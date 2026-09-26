import type { CostAdapterId } from '@nova/contracts';

/**
 * Adaptery raportów kosztów dostawców (odczyt, bez zapisu u dostawcy). Klucze administracyjne wyłącznie
 * w konfiguracji serwera (zmienne środowiskowe) — nigdy w bazie, odpowiedziach API ani audycie.
 * „Podłączony” = po udanej synchronizacji; do tego czasu UI pokazuje „niepodłączone”.
 * Dokumentacja sprawdzona 2026-09-26 (docs/DECISIONS.md D-029). Adresy można podmienić w testach.
 */
export interface CostReportDay {
  /** Dzień UTC (YYYY-MM-DD). */
  day: string;
  amountMicros: number;
  currency: string;
}

export class CostAdapterError extends Error {
  constructor(
    public readonly code: 'not_configured' | 'unauthorized' | 'rate_limited' | 'provider_error',
    message: string,
  ) {
    super(message);
  }
}

export interface CostAdapter {
  readonly id: CostAdapterId;
  readonly title: string;
  readonly docsUrl: string;
  readonly docsVerifiedAt: string;
  keyConfigured(): boolean;
  /** Koszty dzienne w przedziale [from, to) (UTC), zsumowane per dzień i waluta. */
  fetchDaily(from: Date, to: Date): Promise<CostReportDay[]>;
}

/** Tekst dziesiętny → mikro-jednostki (`unitMicros` = ile mikro ma jednostka tekstu, np. cent = 10 000). */
export function decimalToMicros(text: string, unitMicros: number): number {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new CostAdapterError('provider_error', 'nieprawidłowa kwota w raporcie');
  const scale = Math.round(Math.log10(unitMicros));
  const frac = (m[2] ?? '').padEnd(scale + 1, '0');
  const base = Number(m[1]) * unitMicros + Number(frac.slice(0, scale) || '0');
  return base + (Number(frac[scale]) >= 5 ? 1 : 0);
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: ctrl.signal });
  } catch {
    throw new CostAdapterError('provider_error', 'brak połączenia z dostawcą');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403)
    throw new CostAdapterError(
      'unauthorized',
      'klucz administracyjny odrzucony (sprawdź klucz i uprawnienia organizacji)',
    );
  if (res.status === 429)
    throw new CostAdapterError('rate_limited', 'limit zapytań dostawcy — spróbuj później');
  if (res.status >= 400) throw new CostAdapterError('provider_error', `HTTP ${res.status}`);
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new CostAdapterError('provider_error', 'nieprawidłowa odpowiedź dostawcy');
  }
}

const MAX_PAGES = 10;
const day = (iso: string) => iso.slice(0, 10);

function addDay(map: Map<string, CostReportDay>, d: string, currency: string, micros: number) {
  const key = `${d}|${currency}`;
  const cur = map.get(key);
  if (cur) cur.amountMicros += micros;
  else map.set(key, { day: d, amountMicros: micros, currency });
}

/**
 * Anthropic — Usage & Cost Admin API: `GET /v1/organizations/cost_report` (dzienne kubełki, `limit` ≤ 31,
 * stronicowanie `has_more`/`next_page`), nagłówki `x-api-key` (klucz administracyjny `sk-ant-admin…`)
 * i `anthropic-version: 2023-06-01`. Kwoty: tekst dziesiętny w najmniejszych jednostkach (centy), waluta USD.
 * Niedostępne dla kont indywidualnych; koszty Priority Tier nie są w tym raporcie.
 */
export class AnthropicCostAdapter implements CostAdapter {
  readonly id = 'anthropic' as const;
  readonly title = 'Anthropic (Claude API) — raport kosztów organizacji';
  readonly docsUrl = 'https://platform.claude.com/docs/en/manage-claude/usage-cost-api';
  readonly docsVerifiedAt = '2026-09-26';

  constructor(
    private readonly adminKey: string,
    private readonly base = 'https://api.anthropic.com',
    private readonly timeoutMs = 15_000,
  ) {}

  keyConfigured(): boolean {
    return this.adminKey.length > 0;
  }

  async fetchDaily(from: Date, to: Date): Promise<CostReportDay[]> {
    if (!this.keyConfigured())
      throw new CostAdapterError('not_configured', 'brak ANTHROPIC_ADMIN_API_KEY');
    const out = new Map<string, CostReportDay>();
    let page: string | null = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const q = new URLSearchParams({
        starting_at: from.toISOString(),
        ending_at: to.toISOString(),
        bucket_width: '1d',
        limit: '31',
      });
      if (page) q.set('page', page);
      const body = await getJson(
        `${this.base}/v1/organizations/cost_report?${q}`,
        {
          'x-api-key': this.adminKey,
          'anthropic-version': '2023-06-01',
          'user-agent': 'NovaAI/0.1 (cost sync)',
        },
        this.timeoutMs,
      );
      const data = Array.isArray(body.data) ? (body.data as Array<Record<string, unknown>>) : [];
      for (const bucket of data) {
        const d = day(String(bucket.starting_at ?? ''));
        const results = Array.isArray(bucket.results)
          ? (bucket.results as Array<Record<string, unknown>>)
          : [];
        for (const r of results) {
          const currency = String(r.currency ?? 'USD').toUpperCase();
          addDay(out, d, currency, decimalToMicros(String(r.amount ?? '0'), 10_000));
        }
      }
      page = body.has_more === true && typeof body.next_page === 'string' ? body.next_page : null;
      if (!page) break;
    }
    return [...out.values()];
  }
}

/**
 * OpenAI — Costs API: `GET /v1/organization/costs` (Unix `start_time`/`end_time`, `bucket_width=1d`,
 * `limit` 1–180, stronicowanie `has_more`/`next_page`), nagłówek `Authorization: Bearer` z kluczem
 * administracyjnym. Kwoty: `amount.value` w dolarach (liczba), `amount.currency` („usd”).
 */
export class OpenAICostAdapter implements CostAdapter {
  readonly id = 'openai' as const;
  readonly title = 'OpenAI API — raport kosztów organizacji';
  readonly docsUrl = 'https://developers.openai.com/cookbook/examples/completions_usage_api';
  readonly docsVerifiedAt = '2026-09-26';

  constructor(
    private readonly adminKey: string,
    private readonly base = 'https://api.openai.com',
    private readonly timeoutMs = 15_000,
  ) {}

  keyConfigured(): boolean {
    return this.adminKey.length > 0;
  }

  async fetchDaily(from: Date, to: Date): Promise<CostReportDay[]> {
    if (!this.keyConfigured())
      throw new CostAdapterError('not_configured', 'brak OPENAI_ADMIN_API_KEY');
    const out = new Map<string, CostReportDay>();
    let page: string | null = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const q = new URLSearchParams({
        start_time: String(Math.floor(from.getTime() / 1000)),
        end_time: String(Math.floor(to.getTime() / 1000)),
        bucket_width: '1d',
        limit: '31',
      });
      if (page) q.set('page', page);
      const body = await getJson(
        `${this.base}/v1/organization/costs?${q}`,
        { authorization: `Bearer ${this.adminKey}` },
        this.timeoutMs,
      );
      const data = Array.isArray(body.data) ? (body.data as Array<Record<string, unknown>>) : [];
      for (const bucket of data) {
        const d = new Date(Number(bucket.start_time ?? 0) * 1000).toISOString().slice(0, 10);
        const results = Array.isArray(bucket.results)
          ? (bucket.results as Array<Record<string, unknown>>)
          : [];
        for (const r of results) {
          const amount = (r.amount ?? {}) as { value?: unknown; currency?: unknown };
          const value = Number(amount.value ?? 0);
          if (!Number.isFinite(value) || value < 0)
            throw new CostAdapterError('provider_error', 'nieprawidłowa kwota w raporcie');
          addDay(out, d, String(amount.currency ?? 'usd').toUpperCase(), Math.round(value * 1e6));
        }
      }
      page = body.has_more === true && typeof body.next_page === 'string' ? body.next_page : null;
      if (!page) break;
    }
    return [...out.values()];
  }
}

export type CostAdapterRegistry = ReadonlyMap<CostAdapterId, CostAdapter>;

export function createCostAdapters(
  keys: { anthropic: string; openai: string },
  bases: { anthropic?: string; openai?: string } = {},
): CostAdapterRegistry {
  return new Map<CostAdapterId, CostAdapter>([
    ['anthropic', new AnthropicCostAdapter(keys.anthropic, bases.anthropic)],
    ['openai', new OpenAICostAdapter(keys.openai, bases.openai)],
  ]);
}
