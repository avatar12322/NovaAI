import { randomUUID } from 'node:crypto';
import {
  CreateHouseholdModel,
  CreateModelProvider,
  isLocalBaseUrl,
  MODEL_PROVIDER_PRESETS,
  SetFxRate,
  UpdateHouseholdModel,
  UpdateModelProvider,
  type HouseholdModelInfo,
  type ModelProviderInfo,
  type ModelsOverview,
  type ProviderCheckResult,
} from '@nova/contracts';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { isUuid, requireAuth } from '../access';
import { writeAudit } from '../audit';
import type { AuthContext } from '../auth/session';
import { withUserTx } from '../db/pool';
import type { AppDeps } from '../deps';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors';
import { RateLimiter } from '../lib/rate-limit';
import { parse } from '../lib/validate';
import { checkProvider, keyHint, providerKeyAad } from './household';

/**
 * „Modele AI i klucze API” (DECISIONS D-030): dostawcy, modele z cennikiem i kursy walut domu.
 * Zmienia wyłącznie właściciel domu; domownik widzi stan (bez kluczy). Klucz API jest tylko do zapisu:
 * trafia zaszyfrowany do bazy, a odpowiedzi, audyt i logi zawierają najwyżej jego ostatnie 4 znaki.
 */

interface ProviderRow {
  id: string;
  name: string;
  label: string;
  kind: 'anthropic' | 'openai_compatible';
  base_url: string | null;
  key_hint: string | null;
  enabled: boolean;
  last_check_at: string | null;
  last_check_ok: boolean | null;
  last_check_message: string | null;
  created_at: string;
  updated_at: string;
  model_count: number;
}

interface ModelRow {
  id: string;
  provider_id: string;
  provider_name: string;
  name: string;
  model: string;
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
  enabled: boolean;
}

const num = (v: string | null) => (v === null ? null : Number(v));

const NO_VAULT =
  'Serwer nie ma ustawionego NOVA_SECRET_KEY — klucza API nie da się bezpiecznie zapisać. ' +
  'Ustaw NOVA_SECRET_KEY w pliku .env i uruchom serwer ponownie.';

/** Naruszenie unikalności nazwy => 409 z czytelnym komunikatem. */
function mapUnique(e: unknown, what: string): never {
  if ((e as { code?: string }).code === '23505')
    throw conflict('name_taken', `${what} o tej nazwie już istnieje w domu — wybierz inną nazwę`);
  throw e;
}

export const modelProviderRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const checkLimiter = new RateLimiter(10, 60_000);

    const member = (req: FastifyRequest): { auth: AuthContext; householdId: string } => {
      const auth = requireAuth(req);
      if (!auth.householdId) throw forbidden('Brak aktywnego członkostwa w domu');
      return { auth, householdId: auth.householdId };
    };
    const owner = (req: FastifyRequest) => {
      const m = member(req);
      if (m.auth.householdRole !== 'owner')
        throw forbidden('Dostawców modeli i klucze API zmienia tylko właściciel domu');
      return m;
    };
    const audit = (
      req: FastifyRequest,
      m: { auth: AuthContext; householdId: string },
      action: string,
      resourceId: string,
      details: Record<string, unknown>,
      outcome: 'ok' | 'error' = 'ok',
    ) =>
      writeAudit(deps.db, {
        actorKind: 'user',
        actorUserId: m.auth.userId,
        ownerUserId: m.auth.userId,
        householdId: m.householdId,
        source: 'api',
        action,
        resourceType: action.startsWith('model_provider') ? 'model_provider' : 'household_model',
        resourceId,
        outcome,
        correlationId: req.id,
        details,
      });
    const idParam = (id: string) => {
      if (!isUuid(id)) throw notFound('Zasób');
      return id;
    };

    /** Lokalny adres (http://localhost) tylko, gdy serwer na to pozwala. */
    const checkBaseUrl = (kind: string, baseUrl: string | null | undefined) => {
      if (kind === 'openai_compatible' && !baseUrl)
        throw badRequest('Podaj adres serwera (np. https://api.openai.com/v1)');
      if (isLocalBaseUrl(baseUrl) && !deps.config.modelsAllowLocal)
        throw badRequest(
          'Lokalny serwer (http://localhost) jest wyłączony na tym serwerze (NOVA_MODELS_ALLOW_LOCAL)',
        );
    };

    const encryptKey = (householdId: string, providerId: string, apiKey: string) => {
      if (!deps.vault) throw new HttpError(400, 'no_vault', NO_VAULT);
      return deps.vault.encrypt(apiKey, providerKeyAad(householdId, providerId));
    };

    async function overview(auth: AuthContext, householdId: string): Promise<ModelsOverview> {
      // Odczyt przez rolę aplikacji z RLS — kolumna z szyfrogramem nie jest dla niej dostępna.
      const { providers, models, fx } = await withUserTx(
        deps.db,
        { userId: auth.userId, scope: 'user' },
        async (c) => ({
          providers: (
            await c.query<ProviderRow>(
              `SELECT p.id, p.name, p.label, p.kind, p.base_url, p.key_hint, p.enabled, p.last_check_at,
                      p.last_check_ok, p.last_check_message, p.created_at, p.updated_at,
                      (SELECT count(*) FROM household_models m WHERE m.provider_id = p.id)::int AS model_count
                 FROM model_providers p WHERE p.household_id = $1 ORDER BY p.created_at, p.name`,
              [householdId],
            )
          ).rows,
          models: (
            await c.query<ModelRow>(
              `SELECT m.id, m.provider_id, p.name AS provider_name, m.name, m.model, m.max_tokens,
                      m.data_policy, m.price_currency, m.input_per_mtok::text, m.output_per_mtok::text,
                      m.cache_read_per_mtok::text, m.cache_write_per_mtok::text, m.pricing_source,
                      to_char(m.pricing_verified_at, 'YYYY-MM-DD') AS pricing_verified_at,
                      m.use_simple, m.use_complex, m.priority, m.enabled
                 FROM household_models m JOIN model_providers p ON p.id = m.provider_id
                WHERE m.household_id = $1 ORDER BY m.priority, m.name`,
              [householdId],
            )
          ).rows,
          fx: (
            await c.query<{ currency: string; rate: string; updated_at: string }>(
              `SELECT currency, rate::text, updated_at FROM household_fx
                WHERE household_id = $1 ORDER BY currency`,
              [householdId],
            )
          ).rows,
        }),
      );
      const [snap, base] = [await deps.gateway.snapshot(householdId), deps.gateway.status()];
      const fileProviders = Object.keys(deps.gateway.config.providers);
      const currency = deps.gateway.config.currency;

      const providerInfo = (p: ProviderRow): ModelProviderInfo => {
        const shadowed = fileProviders.includes(p.name);
        const usable = !shadowed && snap.providers.has(p.name);
        return {
          id: p.id,
          name: p.name,
          label: p.label,
          kind: p.kind,
          baseUrl: p.base_url,
          hasKey: p.key_hint !== null,
          keyHint: p.key_hint,
          enabled: p.enabled,
          usable,
          reason: usable
            ? null
            : shadowed
              ? 'nazwa zajęta przez konfigurację serwera'
              : (snap.providerErrors.get(p.name) ?? 'dostawca niedostępny'),
          lastCheck: p.last_check_at
            ? {
                at: p.last_check_at,
                ok: p.last_check_ok === true,
                message: p.last_check_message,
              }
            : null,
          modelCount: p.model_count,
          createdAt: p.created_at,
          updatedAt: p.updated_at,
        };
      };
      const modelInfo = (m: ModelRow): HouseholdModelInfo => {
        const a = snap.availability(m.name);
        const shadowed = m.name in deps.gateway.config.models;
        const available = m.enabled && !shadowed && a.available;
        return {
          id: m.id,
          providerId: m.provider_id,
          providerName: m.provider_name,
          name: m.name,
          model: m.model,
          maxTokens: m.max_tokens,
          dataPolicy: m.data_policy,
          pricing: {
            currency: m.price_currency,
            inputPerMTok: Number(m.input_per_mtok),
            outputPerMTok: Number(m.output_per_mtok),
            cacheReadPerMTok: num(m.cache_read_per_mtok),
            cacheWritePerMTok: num(m.cache_write_per_mtok),
            source: m.pricing_source,
            verifiedAt: m.pricing_verified_at,
          },
          useSimple: m.use_simple,
          useComplex: m.use_complex,
          priority: m.priority,
          enabled: m.enabled,
          available,
          reason: available
            ? null
            : !m.enabled
              ? 'model wyłączony'
              : shadowed
                ? 'nazwa zajęta przez konfigurację serwera'
                : a.reason,
        };
      };
      const missingFx = [
        ...new Set(
          models
            .filter((m) => m.enabled && m.price_currency !== currency)
            .map((m) => m.price_currency)
            .filter((c) => !snap.config.fx[c]),
        ),
      ].sort();
      return {
        canManage: auth.householdRole === 'owner',
        vaultReady: deps.vault !== null,
        currency,
        mode: snap.hasAvailable() ? 'configured' : 'demo',
        presets: MODEL_PROVIDER_PRESETS,
        providers: providers.map(providerInfo),
        models: models.map(modelInfo),
        fileProviders,
        fileModels: base.models.map((m) => ({
          key: m.key,
          provider: m.provider,
          model: m.model,
          available: m.available,
          reason: m.reason,
        })),
        fx: fx.map((f) => ({
          currency: f.currency,
          rate: Number(f.rate),
          updatedAt: f.updated_at,
        })),
        missingFx,
      };
    }

    const changed = (householdId: string) => deps.gateway.invalidate(householdId);

    app.get('/model/providers', async (req) => {
      const m = member(req);
      return overview(m.auth, m.householdId);
    });

    app.post('/model/providers', async (req) => {
      const m = owner(req);
      const body = parse(CreateModelProvider, req.body);
      if (deps.gateway.config.providers[body.name])
        throw conflict(
          'name_taken',
          `Nazwa „${body.name}” jest używana przez konfigurację serwera — wybierz inną`,
        );
      checkBaseUrl(body.kind, body.baseUrl);
      const id = randomUUID();
      const enc = body.apiKey ? encryptKey(m.householdId, id, body.apiKey) : null;
      await deps.db.owner
        .query(
          `INSERT INTO model_providers (id, household_id, name, label, kind, base_url, key_ciphertext, key_id,
             key_hint, enabled, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            id,
            m.householdId,
            body.name,
            body.label,
            body.kind,
            body.baseUrl ?? null,
            enc?.blob ?? null,
            enc?.keyId ?? null,
            body.apiKey ? keyHint(body.apiKey) : null,
            body.enabled ?? true,
            m.auth.userId,
          ],
        )
        .catch((e: unknown) => mapUnique(e, 'Dostawca'));
      changed(m.householdId);
      await audit(req, m, 'model_provider.create', id, {
        name: body.name,
        kind: body.kind,
        baseUrl: body.baseUrl ?? null,
        hasKey: !!body.apiKey,
      });
      return overview(m.auth, m.householdId);
    });

    app.patch<{ Params: { id: string } }>('/model/providers/:id', async (req) => {
      const m = owner(req);
      const id = idParam(req.params.id);
      const body = parse(UpdateModelProvider, req.body);
      const cur = await deps.db.owner.query<{ kind: string; base_url: string | null }>(
        'SELECT kind, base_url FROM model_providers WHERE id = $1 AND household_id = $2',
        [id, m.householdId],
      );
      const row = cur.rows[0];
      if (!row) throw notFound('Dostawca');
      const baseUrl = body.baseUrl === undefined ? row.base_url : body.baseUrl;
      if (body.baseUrl !== undefined) checkBaseUrl(row.kind, baseUrl);
      const sets: string[] = [];
      const vals: unknown[] = [id, m.householdId];
      const set = (col: string, v: unknown) => {
        vals.push(v);
        sets.push(`${col} = $${vals.length}`);
      };
      if (body.label !== undefined) set('label', body.label);
      if (body.enabled !== undefined) set('enabled', body.enabled);
      if (body.baseUrl !== undefined) set('base_url', baseUrl);
      if (body.apiKey) {
        const enc = encryptKey(m.householdId, id, body.apiKey);
        set('key_ciphertext', enc.blob);
        set('key_id', enc.keyId);
        set('key_hint', keyHint(body.apiKey));
      } else if (body.removeKey) {
        set('key_ciphertext', null);
        set('key_id', null);
        set('key_hint', null);
      }
      // Nowy klucz lub adres => poprzedni wynik sprawdzenia nieaktualny.
      if (body.apiKey || body.removeKey || body.baseUrl !== undefined) {
        set('last_check_at', null);
        set('last_check_ok', null);
        set('last_check_message', null);
      }
      if (sets.length)
        await deps.db.owner.query(
          `UPDATE model_providers SET ${sets.join(', ')}, updated_at = now()
            WHERE id = $1 AND household_id = $2`,
          vals,
        );
      changed(m.householdId);
      await audit(req, m, 'model_provider.update', id, {
        fields: Object.keys(body).filter((k) => k !== 'apiKey'),
        keyReplaced: !!body.apiKey,
        keyRemoved: !!body.removeKey,
      });
      return overview(m.auth, m.householdId);
    });

    app.delete<{ Params: { id: string } }>('/model/providers/:id', async (req) => {
      const m = owner(req);
      const id = idParam(req.params.id);
      const r = await deps.db.owner.query<{ name: string }>(
        'DELETE FROM model_providers WHERE id = $1 AND household_id = $2 RETURNING name',
        [id, m.householdId],
      );
      if (!r.rows[0]) throw notFound('Dostawca');
      changed(m.householdId);
      await audit(req, m, 'model_provider.delete', id, { name: r.rows[0].name });
      return overview(m.auth, m.householdId);
    });

    /** Sprawdzenie klucza bez kosztów: lista modeli u dostawcy. Wynik zapisany przy dostawcy. */
    app.post<{ Params: { id: string } }>(
      '/model/providers/:id/check',
      async (req): Promise<ProviderCheckResult> => {
        const m = owner(req);
        const id = idParam(req.params.id);
        if (!checkLimiter.hit(m.auth.userId))
          throw new HttpError(429, 'rate_limited', 'Zbyt wiele sprawdzeń — spróbuj za minutę');
        const cur = await deps.db.owner.query<{
          kind: 'anthropic' | 'openai_compatible';
          base_url: string | null;
          key_ciphertext: Buffer | null;
          key_id: string | null;
        }>(
          `SELECT kind, base_url, key_ciphertext, key_id FROM model_providers
            WHERE id = $1 AND household_id = $2`,
          [id, m.householdId],
        );
        const row = cur.rows[0];
        if (!row) throw notFound('Dostawca');
        let result: ProviderCheckResult;
        if (isLocalBaseUrl(row.base_url) && !deps.config.modelsAllowLocal) {
          result = {
            ok: false,
            message: 'Lokalny serwer jest wyłączony na tym serwerze',
            models: [],
          };
        } else if (!row.key_ciphertext && !isLocalBaseUrl(row.base_url)) {
          result = { ok: false, message: 'Najpierw wpisz klucz API', models: [] };
        } else {
          let apiKey: string | null = null;
          if (row.key_ciphertext && row.key_id) {
            if (!deps.vault) throw new HttpError(400, 'no_vault', NO_VAULT);
            try {
              apiKey = deps.vault.decrypt(
                row.key_ciphertext,
                row.key_id,
                providerKeyAad(m.householdId, id),
              );
            } catch {
              apiKey = null;
            }
          }
          result =
            row.key_ciphertext && apiKey === null
              ? {
                  ok: false,
                  message:
                    'Nie można odszyfrować klucza (zmieniono NOVA_SECRET_KEY?) — wpisz go ponownie',
                  models: [],
                }
              : await checkProvider({ kind: row.kind, baseUrl: row.base_url, apiKey });
        }
        await deps.db.owner.query(
          `UPDATE model_providers SET last_check_at = now(), last_check_ok = $3, last_check_message = $4
            WHERE id = $1 AND household_id = $2`,
          [id, m.householdId, result.ok, result.message.slice(0, 300)],
        );
        await audit(
          req,
          m,
          'model_provider.check',
          id,
          { ok: result.ok, models: result.models.length },
          result.ok ? 'ok' : 'error',
        );
        return result;
      },
    );

    app.post('/model/models', async (req) => {
      const m = owner(req);
      const body = parse(CreateHouseholdModel, req.body);
      if (deps.gateway.config.models[body.name])
        throw conflict(
          'name_taken',
          `Nazwa „${body.name}” jest używana przez konfigurację serwera — wybierz inną`,
        );
      const p = await deps.db.owner.query(
        'SELECT 1 FROM model_providers WHERE id = $1 AND household_id = $2',
        [body.providerId, m.householdId],
      );
      if (!p.rowCount) throw notFound('Dostawca');
      const id = randomUUID();
      await deps.db.owner
        .query(
          `INSERT INTO household_models (id, household_id, provider_id, name, model, max_tokens, data_policy,
             price_currency, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok,
             pricing_source, pricing_verified_at, use_simple, use_complex, priority, enabled)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [
            id,
            m.householdId,
            body.providerId,
            body.name,
            body.model,
            body.maxTokens,
            body.dataPolicy,
            body.pricing.currency,
            body.pricing.inputPerMTok,
            body.pricing.outputPerMTok,
            body.pricing.cacheReadPerMTok ?? null,
            body.pricing.cacheWritePerMTok ?? null,
            body.pricing.source || null,
            body.pricing.verifiedAt ?? null,
            body.useSimple,
            body.useComplex,
            body.priority,
            body.enabled,
          ],
        )
        .catch((e: unknown) => mapUnique(e, 'Model'));
      changed(m.householdId);
      await audit(req, m, 'household_model.create', id, {
        name: body.name,
        model: body.model,
        pricing: body.pricing,
      });
      return overview(m.auth, m.householdId);
    });

    app.patch<{ Params: { id: string } }>('/model/models/:id', async (req) => {
      const m = owner(req);
      const id = idParam(req.params.id);
      const body = parse(UpdateHouseholdModel, req.body);
      const cur = await deps.db.owner.query<{ use_simple: boolean; use_complex: boolean }>(
        'SELECT use_simple, use_complex FROM household_models WHERE id = $1 AND household_id = $2',
        [id, m.householdId],
      );
      const row = cur.rows[0];
      if (!row) throw notFound('Model');
      if (!(body.useSimple ?? row.use_simple) && !(body.useComplex ?? row.use_complex))
        throw badRequest('Wybierz co najmniej jedno zastosowanie modelu');
      const sets: string[] = [];
      const vals: unknown[] = [id, m.householdId];
      const set = (col: string, v: unknown) => {
        vals.push(v);
        sets.push(`${col} = $${vals.length}`);
      };
      if (body.model !== undefined) set('model', body.model);
      if (body.maxTokens !== undefined) set('max_tokens', body.maxTokens);
      if (body.dataPolicy !== undefined) set('data_policy', body.dataPolicy);
      if (body.useSimple !== undefined) set('use_simple', body.useSimple);
      if (body.useComplex !== undefined) set('use_complex', body.useComplex);
      if (body.priority !== undefined) set('priority', body.priority);
      if (body.enabled !== undefined) set('enabled', body.enabled);
      if (body.pricing) {
        set('price_currency', body.pricing.currency);
        set('input_per_mtok', body.pricing.inputPerMTok);
        set('output_per_mtok', body.pricing.outputPerMTok);
        set('cache_read_per_mtok', body.pricing.cacheReadPerMTok ?? null);
        set('cache_write_per_mtok', body.pricing.cacheWritePerMTok ?? null);
        set('pricing_source', body.pricing.source || null);
        set('pricing_verified_at', body.pricing.verifiedAt ?? null);
      }
      if (sets.length)
        await deps.db.owner.query(
          `UPDATE household_models SET ${sets.join(', ')}, updated_at = now()
            WHERE id = $1 AND household_id = $2`,
          vals,
        );
      changed(m.householdId);
      await audit(req, m, 'household_model.update', id, { fields: Object.keys(body) });
      return overview(m.auth, m.householdId);
    });

    app.delete<{ Params: { id: string } }>('/model/models/:id', async (req) => {
      const m = owner(req);
      const id = idParam(req.params.id);
      const r = await deps.db.owner.query<{ name: string }>(
        'DELETE FROM household_models WHERE id = $1 AND household_id = $2 RETURNING name',
        [id, m.householdId],
      );
      if (!r.rows[0]) throw notFound('Model');
      changed(m.householdId);
      await audit(req, m, 'household_model.delete', id, { name: r.rows[0].name });
      return overview(m.auth, m.householdId);
    });

    /** Kurs waluty cennika do waluty budżetu (1 USD = X PLN). null usuwa kurs. */
    app.put('/model/fx', async (req) => {
      const m = owner(req);
      const body = parse(SetFxRate, req.body);
      if (body.currency === deps.gateway.config.currency)
        throw badRequest(`${body.currency} to waluta budżetu — kurs nie jest potrzebny`);
      if (body.rate === null)
        await deps.db.owner.query(
          'DELETE FROM household_fx WHERE household_id = $1 AND currency = $2',
          [m.householdId, body.currency],
        );
      else
        await deps.db.owner.query(
          `INSERT INTO household_fx (household_id, currency, rate, updated_by) VALUES ($1,$2,$3,$4)
           ON CONFLICT (household_id, currency)
           DO UPDATE SET rate = EXCLUDED.rate, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [m.householdId, body.currency, body.rate, m.auth.userId],
        );
      changed(m.householdId);
      await audit(req, m, 'household_model.fx', m.householdId, body);
      return overview(m.auth, m.householdId);
    });
  };
