import { isLocalBaseUrl, type ProviderCheckResult } from '@nova/contracts';
import type { Vault } from '../connectors/vault';
import type { Db } from '../db/pool';
import type { HouseholdModelSource, HouseholdOverlay } from './gateway';

/**
 * Dostawcy i modele dodani w aplikacji (tabele model_providers, household_models, household_fx).
 * Klucze są odszyfrowywane wyłącznie tutaj, w pamięci serwera, na potrzeby wywołań modelu.
 */

/** AAD wiąże szyfrogram klucza z domem i rekordem dostawcy (podmiana rekordów => błąd odszyfrowania). */
export const providerKeyAad = (householdId: string, providerId: string) =>
  `model_provider|${householdId}|${providerId}`;

/** Ostatnie 4 znaki klucza — do rozpoznania, który klucz jest zapisany. */
export const keyHint = (key: string) => key.slice(-4);

interface ProviderRow {
  id: string;
  name: string;
  kind: 'anthropic' | 'openai_compatible';
  base_url: string | null;
  key_ciphertext: Buffer | null;
  key_id: string | null;
  enabled: boolean;
}

interface ModelRow {
  name: string;
  model: string;
  provider_name: string;
  max_tokens: number;
  data_policy: 'private_ok' | 'shared_only';
  price_currency: string;
  input_per_mtok: string;
  output_per_mtok: string;
  cache_read_per_mtok: string | null;
  cache_write_per_mtok: string | null;
  pricing_source: string | null;
  pricing_verified_at: string | null;
  use_simple: boolean;
  use_complex: boolean;
  priority: number;
}

const num = (v: string | null) => (v === null ? null : Number(v));

export class DbHouseholdModels implements HouseholdModelSource {
  constructor(
    private readonly db: Db,
    private readonly vault: Vault | null,
    private readonly allowLocal: boolean,
  ) {}

  async load(householdId: string): Promise<HouseholdOverlay | null> {
    const [providers, models, fx] = await Promise.all([
      this.db.owner.query<ProviderRow>(
        `SELECT id, name, kind, base_url, key_ciphertext, key_id, enabled
           FROM model_providers WHERE household_id = $1`,
        [householdId],
      ),
      this.db.owner.query<ModelRow>(
        `SELECT m.name, m.model, COALESCE(p.name, m.server_provider) AS provider_name, m.max_tokens, m.data_policy, m.price_currency,
                m.input_per_mtok::text, m.output_per_mtok::text, m.cache_read_per_mtok::text,
                m.cache_write_per_mtok::text, m.pricing_source,
                to_char(m.pricing_verified_at, 'YYYY-MM-DD') AS pricing_verified_at,
                m.use_simple, m.use_complex, m.priority
           FROM household_models m LEFT JOIN model_providers p ON p.id = m.provider_id
          WHERE m.household_id = $1 AND m.enabled`,
        [householdId],
      ),
      this.db.owner.query<{ currency: string; rate: string }>(
        'SELECT currency, rate::text FROM household_fx WHERE household_id = $1',
        [householdId],
      ),
    ]);
    if (!providers.rows.length && !models.rows.length && !fx.rows.length) return null;

    const overlay: HouseholdOverlay = { providers: {}, models: {}, fx: {} };
    for (const p of providers.rows) {
      let apiKey: string | null = null;
      let error: string | null = null;
      if (p.key_ciphertext && p.key_id) {
        if (!this.vault) error = 'brak NOVA_SECRET_KEY na serwerze — nie można odczytać klucza';
        else {
          try {
            apiKey = this.vault.decrypt(
              p.key_ciphertext,
              p.key_id,
              providerKeyAad(householdId, p.id),
            );
          } catch {
            error =
              'nie można odszyfrować klucza (zmieniono NOVA_SECRET_KEY?) — wpisz klucz ponownie';
          }
        }
      }
      if (!error && isLocalBaseUrl(p.base_url) && !this.allowLocal)
        error = 'lokalny serwer niedozwolony na tym serwerze (NOVA_MODELS_ALLOW_LOCAL)';
      overlay.providers[p.name] = {
        kind: p.kind,
        baseUrl: p.base_url,
        apiKey,
        enabled: p.enabled,
        error,
      };
    }
    for (const m of models.rows) {
      overlay.models[m.name] = {
        provider: m.provider_name,
        model: m.model,
        maxTokens: m.max_tokens,
        dataPolicy: m.data_policy,
        pricing: {
          currency: m.price_currency,
          inputPerMTok: Number(m.input_per_mtok),
          outputPerMTok: Number(m.output_per_mtok),
          cacheReadPerMTok: num(m.cache_read_per_mtok),
          cacheWritePerMTok: num(m.cache_write_per_mtok),
          verifiedAt: m.pricing_verified_at,
          source: m.pricing_source ?? 'household',
        },
        routes: [
          ...(m.use_simple ? ['chat.simple'] : []),
          ...(m.use_complex ? ['chat.complex'] : []),
        ],
        priority: m.priority,
      };
    }
    for (const f of fx.rows) overlay.fx[f.currency] = Number(f.rate);
    return overlay;
  }
}

/** Ponowne zaszyfrowanie kluczy dostawców bieżącym kluczem głównym (po rotacji NOVA_SECRET_KEY). */
export async function rotateProviderKeys(db: Db, vault: Vault): Promise<number> {
  const rows = await db.owner.query<{
    id: string;
    household_id: string;
    key_ciphertext: Buffer;
    key_id: string;
  }>(
    'SELECT id, household_id, key_ciphertext, key_id FROM model_providers WHERE key_ciphertext IS NOT NULL',
  );
  let n = 0;
  for (const r of rows.rows) {
    if (!vault.needsRotation(r.key_id)) continue;
    const aad = providerKeyAad(r.household_id, r.id);
    const enc = vault.encrypt(vault.decrypt(r.key_ciphertext, r.key_id, aad), aad);
    await db.owner.query(
      'UPDATE model_providers SET key_ciphertext = $2, key_id = $3, updated_at = now() WHERE id = $1',
      [r.id, enc.blob, enc.keyId],
    );
    n++;
  }
  return n;
}

const ANTHROPIC_BASE = 'https://api.anthropic.com';
const MODEL_ID_RE = /^[\x21-\x7e]{1,120}$/;

/**
 * Sprawdzenie klucza bez kosztów: lista modeli dostawcy.
 * Anthropic: GET /v1/models (x-api-key, anthropic-version); zgodne z OpenAI (OpenAI, Gemini): GET {base}/models
 * z nagłówkiem Bearer. Treść odpowiedzi dostawcy nie jest przekazywana dalej — tylko status i ID modeli.
 */
export async function checkProvider(
  p: { kind: 'anthropic' | 'openai_compatible'; baseUrl: string | null; apiKey: string | null },
  timeoutMs = 10_000,
): Promise<ProviderCheckResult> {
  if (p.kind === 'openai_compatible' && !p.baseUrl)
    return { ok: false, message: 'Brak adresu serwera', models: [] };
  const base = (p.baseUrl ?? ANTHROPIC_BASE).replace(/\/+$/, '');
  const url = p.kind === 'anthropic' ? `${base}/v1/models?limit=1000` : `${base}/models`;
  const headers: Record<string, string> =
    p.kind === 'anthropic'
      ? { 'x-api-key': p.apiKey ?? '', 'anthropic-version': '2023-06-01' }
      : p.apiKey
        ? { authorization: `Bearer ${p.apiKey}` }
        : {};
  let res: Response;
  try {
    res = await fetch(url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timeout = (e as Error).name === 'TimeoutError';
    return {
      ok: false,
      message: timeout
        ? 'Dostawca nie odpowiedział w czasie — spróbuj później'
        : 'Brak połączenia z serwerem dostawcy — sprawdź adres',
      models: [],
    };
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    return { ok: false, message: `Dostawca odrzucił klucz (HTTP ${res.status})`, models: [] };
  }
  if (!res.ok) {
    await res.body?.cancel();
    const hint =
      res.status === 404
        ? ' — sprawdź adres serwera'
        : res.status === 429
          ? ' — limit zapytań, spróbuj później'
          : '';
    return { ok: false, message: `Dostawca zwrócił błąd HTTP ${res.status}${hint}`, models: [] };
  }
  let ids: string[];
  try {
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) throw new Error('not a list');
    ids = (body.data as Array<{ id?: unknown }>)
      .map((m) => (typeof m.id === 'string' ? m.id.replace(/^models\//, '') : ''))
      .filter((id) => MODEL_ID_RE.test(id))
      .slice(0, 300);
  } catch {
    return {
      ok: false,
      message: 'Nieoczekiwana odpowiedź dostawcy (to nie lista modeli)',
      models: [],
    };
  }
  return {
    ok: true,
    message: ids.length
      ? `Klucz działa — dostawca udostępnia ${ids.length} modeli`
      : 'Połączenie działa, ale dostawca nie zwrócił żadnego modelu',
    models: ids,
  };
}
