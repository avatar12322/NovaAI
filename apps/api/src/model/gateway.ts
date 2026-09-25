import type { Db } from '../db/pool';
import { BudgetBlocked, BudgetService } from './budget';
import {
  isPaid,
  pricingComplete,
  type ModelConfig,
  type ModelsConfig,
  type ProviderConfig,
} from './config';
import { AnthropicProvider } from './providers/anthropic';
import { FakeProvider } from './providers/fake';
import { OpenAiCompatProvider } from './providers/openai-compat';
import {
  ProviderError,
  type ChatMessage,
  type ModelProvider,
  type ProviderResponse,
  type ToolSpec,
} from './types';

export class ModelUnavailable extends Error {}
export { BudgetBlocked };

export interface GatewayRequest {
  capability: string;
  /** Profil runtime agenta (np. 'household') — może mieć własne trasy (profile Hermesa). */
  runtimeProfile: string;
  /** Kontekst prywatny wymaga modelu z dataPolicy=private_ok. */
  containsPrivateData: boolean;
  householdId: string;
  userId: string;
  taskId?: string | null;
  conversationId?: string | null;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
}

export interface GatewayResult extends ProviderResponse {
  modelKey: string;
  provider: string;
  model: string;
  costMicros: number;
  estimated: boolean;
  paid: boolean;
}

export interface ModelAvailability {
  key: string;
  provider: string;
  model: string;
  available: boolean;
  reason: string | null;
  paid: boolean;
  pricingVerified: boolean;
}

/** Szacunek tokenów bez tokenizera dostawcy — ZAWSZE oznaczany jako estymacja. */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

/**
 * ModelGateway: routing per zdolność, wymagania prywatności, budżet (rezerwacja/rozliczenie),
 * zapis rzeczywistego zużycia i kosztu. Ukrywa dostawców przed resztą aplikacji.
 */
export class ModelGateway {
  private readonly providers = new Map<string, ModelProvider>();
  private readonly providerErrors = new Map<string, string>();
  readonly budget: BudgetService;

  constructor(
    private readonly db: Db,
    readonly config: ModelsConfig,
    env: NodeJS.ProcessEnv,
    overrides: Record<string, ModelProvider> = {},
  ) {
    this.budget = new BudgetService(db, config.currency);
    for (const [name, p] of Object.entries(config.providers)) {
      if (overrides[name]) {
        this.providers.set(name, overrides[name]);
        continue;
      }
      const made = makeProvider(name, p, env);
      if (typeof made === 'string') this.providerErrors.set(name, made);
      else this.providers.set(name, made);
    }
  }

  availability(key: string): ModelAvailability {
    const m = this.config.models[key];
    if (!m)
      return {
        key,
        provider: '?',
        model: '?',
        available: false,
        reason: 'nieznany model',
        paid: false,
        pricingVerified: false,
      };
    const base = {
      key,
      provider: m.provider,
      model: m.model,
      paid: isPaid(m.pricing),
      pricingVerified: Boolean(m.pricing.verifiedAt),
    };
    const providerErr = this.providerErrors.get(m.provider);
    if (!this.providers.has(m.provider)) {
      return { ...base, available: false, reason: providerErr ?? 'dostawca nieskonfigurowany' };
    }
    if (!pricingComplete(m.pricing))
      return { ...base, available: false, reason: 'brak cennika (uzupełnij konfigurację)' };
    if (m.pricing.currency !== this.config.currency && !this.config.fx[m.pricing.currency]) {
      return {
        ...base,
        available: false,
        reason: `brak kursu ${m.pricing.currency}→${this.config.currency}`,
      };
    }
    return { ...base, available: true, reason: null };
  }

  status(): { mode: 'configured' | 'demo'; currency: string; models: ModelAvailability[] } {
    const models = Object.keys(this.config.models).map((k) => this.availability(k));
    return {
      mode: this.hasAvailable() ? 'configured' : 'demo',
      currency: this.config.currency,
      models,
    };
  }

  hasAvailable(): boolean {
    return Object.keys(this.config.models).some((k) => this.availability(k).available);
  }

  candidates(capability: string, runtimeProfile: string, containsPrivateData: boolean): string[] {
    const route =
      this.config.profileRoutes[runtimeProfile]?.[capability] ??
      this.config.routes[capability] ??
      [];
    return route.filter((k) => {
      const m = this.config.models[k];
      if (!m || !this.availability(k).available) return false;
      return !containsPrivateData || m.dataPolicy === 'private_ok';
    });
  }

  private fxRate(m: ModelConfig): number {
    return m.pricing.currency === this.config.currency
      ? 1
      : (this.config.fx[m.pricing.currency] ?? 0);
  }

  /** Koszt w mikro-jednostkach waluty budżetu: tokeny × cena za MTok × kurs. */
  costMicros(
    m: ModelConfig,
    u: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    },
  ): number {
    const p = m.pricing;
    const fx = this.fxRate(m);
    const raw =
      u.inputTokens * (p.inputPerMTok ?? 0) +
      u.outputTokens * (p.outputPerMTok ?? 0) +
      u.cacheReadTokens * (p.cacheReadPerMTok ?? p.inputPerMTok ?? 0) +
      u.cacheWriteTokens * (p.cacheWritePerMTok ?? p.inputPerMTok ?? 0);
    return Math.ceil(raw * fx);
  }

  async complete(req: GatewayRequest): Promise<GatewayResult> {
    const keys = this.candidates(req.capability, req.runtimeProfile, req.containsPrivateData);
    if (!keys.length) throw new ModelUnavailable(`Brak dostępnego modelu dla ${req.capability}`);
    const promptChars =
      req.system.length +
      req.messages.reduce((n, m) => n + m.content.length, 0) +
      JSON.stringify(req.tools).length;
    let lastErr: unknown = null;

    for (const key of keys) {
      const m = this.config.models[key]!;
      const provider = this.providers.get(m.provider)!;
      const paid = isPaid(m.pricing);
      // Najgorszy przypadek: konserwatywny szacunek wejścia (znaki/3) + pełne max_tokens wyjścia.
      const worst = this.costMicros(m, {
        inputTokens: Math.ceil(promptChars / 3),
        outputTokens: m.maxTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      const reservation = await this.budget.reserve({
        householdId: req.householdId,
        userId: req.userId,
        taskId: req.taskId,
        conversationId: req.conversationId,
        provider: m.provider,
        model: m.model,
        capability: req.capability,
        paid,
        worstCaseMicros: worst,
        priceSource: m.pricing.verifiedAt
          ? `${m.pricing.source ?? 'config'}@${m.pricing.verifiedAt}`
          : 'config:unverified',
      });
      try {
        const res = await provider.complete({
          model: m.model,
          system: req.system,
          messages: req.messages,
          tools: req.tools,
          maxTokens: m.maxTokens,
          effort: m.effort,
        });
        const estimated = res.usage === null;
        const usage = res.usage ?? {
          inputTokens: estimateTokens(promptChars),
          outputTokens: estimateTokens(res.text.length + JSON.stringify(res.toolCalls).length),
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
        const cost = paid ? this.costMicros(m, usage) : 0;
        await this.budget.settle(reservation, { ...usage, costMicros: cost, estimated });
        return {
          ...res,
          usage,
          modelKey: key,
          provider: m.provider,
          model: m.model,
          costMicros: cost,
          estimated,
          paid,
        };
      } catch (err) {
        await this.budget.fail(reservation);
        lastErr = err;
        if (err instanceof ProviderError && err.retryable) continue; // spróbuj kolejnego modelu z trasy
        throw err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new ModelUnavailable('Wszystkie modele trasy zawiodły');
  }
}

function makeProvider(
  name: string,
  p: ProviderConfig,
  env: NodeJS.ProcessEnv,
): ModelProvider | string {
  switch (p.kind) {
    case 'fake':
      return new FakeProvider();
    case 'anthropic': {
      const key = env[p.apiKeyEnv];
      if (!key) return `brak klucza (${p.apiKeyEnv})`;
      return new AnthropicProvider({ apiKey: key, baseURL: p.baseUrl });
    }
    case 'openai_compatible': {
      const key = env[p.apiKeyEnv];
      const baseUrl = p.baseUrl ?? (p.baseUrlEnv ? env[p.baseUrlEnv] : undefined);
      if (!key) return `brak klucza (${p.apiKeyEnv})`;
      if (!baseUrl) return 'brak adresu serwera (baseUrl/baseUrlEnv)';
      if (p.hermes && !p.hermes.toolsetsDisabledConfirmed) {
        return 'profil Hermesa: niepotwierdzone wyłączenie toolsetów (hermes.toolsetsDisabledConfirmed)';
      }
      return new OpenAiCompatProvider({ baseUrl, apiKey: key, label: name });
    }
  }
}
