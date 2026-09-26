import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Konfiguracja routingu modeli. Nazwy modeli i cenniki pochodzą WYŁĄCZNIE z pliku konfiguracyjnego
 * (nic nie jest wpisane na sztywno w kodzie). Model płatny bez kompletnego cennika jest niedostępny —
 * inaczej budżet nie mógłby być egzekwowany.
 */
const Price = z.number().min(0).nullable();

const PricingSchema = z.object({
  currency: z.string().length(3),
  inputPerMTok: Price,
  outputPerMTok: Price,
  cacheReadPerMTok: Price.optional(),
  cacheWritePerMTok: Price.optional(),
  /** Data weryfikacji cennika w oficjalnym źródle (ISO). null => ostrzeżenie w statusie. */
  verifiedAt: z.string().nullable().optional(),
  source: z.string().optional(),
});
type Pricing = z.infer<typeof PricingSchema>;

const ProviderSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('anthropic'),
    apiKeyEnv: z.string().default('ANTHROPIC_API_KEY'),
    baseUrl: z.string().optional(),
  }),
  z.object({
    kind: z.literal('openai_compatible'),
    apiKeyEnv: z.string(),
    baseUrl: z.string().optional(),
    baseUrlEnv: z.string().optional(),
    /**
     * Hermes API server wykonuje własne narzędzia. Operator musi potwierdzić, że profil ma wyłączone
     * toolsety (config.yaml profilu); bez potwierdzenia dostawca jest niedostępny.
     */
    hermes: z.object({ toolsetsDisabledConfirmed: z.boolean() }).optional(),
  }),
  z.object({ kind: z.literal('fake') }),
]);
export type ProviderConfig = z.infer<typeof ProviderSchema>;

const ModelSchema = z.object({
  provider: z.string(),
  model: z.string().min(1),
  maxTokens: z.number().int().min(16).max(128_000).default(8000),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  /** private_ok: wolno wysyłać prywatny kontekst; shared_only: tylko dane wspólne (NovaAI). */
  dataPolicy: z.enum(['private_ok', 'shared_only']).default('private_ok'),
  pricing: PricingSchema,
});
export type ModelConfig = z.infer<typeof ModelSchema>;

export const ModelsConfigSchema = z.object({
  currency: z.string().length(3).default('PLN'),
  /** Kursy: 1 jednostka waluty cennika = X waluty budżetu. Ustawia operator; brak => model niedostępny. */
  fx: z.record(z.string(), z.number().positive().nullable()).default({}),
  providers: z.record(z.string(), ProviderSchema).default({}),
  models: z.record(z.string(), ModelSchema).default({}),
  routes: z.record(z.string(), z.array(z.string())).default({}),
  /** Nadpisanie tras per profil runtime agenta (np. osobne profile Hermesa). */
  profileRoutes: z.record(z.string(), z.record(z.string(), z.array(z.string()))).default({}),
  routing: z
    .object({
      complexMinChars: z.number().int().min(1).default(1200),
      complexMinHistory: z.number().int().min(1).default(16),
    })
    .default({ complexMinChars: 1200, complexMinHistory: 16 }),
});
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

const EMPTY_MODELS_CONFIG: ModelsConfig = ModelsConfigSchema.parse({});

export function loadModelsConfig(path: string): { config: ModelsConfig; error: string | null } {
  if (!path) return { config: EMPTY_MODELS_CONFIG, error: null };
  if (!existsSync(path))
    return { config: EMPTY_MODELS_CONFIG, error: `Brak pliku konfiguracji modeli: ${path}` };
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const parsed = ModelsConfigSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        config: EMPTY_MODELS_CONFIG,
        error: `Nieprawidłowa konfiguracja modeli: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
      };
    }
    return { config: parsed.data, error: null };
  } catch (e) {
    return {
      config: EMPTY_MODELS_CONFIG,
      error: `Nie można odczytać konfiguracji modeli: ${(e as Error).message}`,
    };
  }
}

export function isPaid(p: Pricing): boolean {
  return [p.inputPerMTok, p.outputPerMTok, p.cacheReadPerMTok, p.cacheWritePerMTok].some(
    (x) => (x ?? 0) > 0,
  );
}

export function pricingComplete(p: Pricing): boolean {
  return p.inputPerMTok !== null && p.outputPerMTok !== null;
}
