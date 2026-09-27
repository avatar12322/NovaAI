import { z } from 'zod';
import { isCurrency } from './money';

/**
 * „Modele AI i klucze API”: dostawcy modeli dodawani w aplikacji (DECISIONS D-030).
 * Klucz API jest tylko do zapisu — odpowiedzi zawierają co najwyżej jego ostatnie 4 znaki.
 */
export const ModelProviderKind = z.enum(['anthropic', 'openai_compatible']);
export type ModelProviderKind = z.infer<typeof ModelProviderKind>;
export const ModelDataPolicy = z.enum(['private_ok', 'shared_only']);
export type ModelDataPolicy = z.infer<typeof ModelDataPolicy>;

export interface ModelProviderPreset {
  id: 'anthropic' | 'openai' | 'gemini' | 'custom';
  label: string;
  /** Proponowana nazwa (używana w kosztach i w „Usługi i koszty”). */
  name: string;
  kind: ModelProviderKind;
  baseUrl: string | null;
  /** Gdzie utworzyć klucz i gdzie sprawdzić aktualny cennik (oficjalne strony dostawcy). */
  keysUrl: string | null;
  pricingUrl: string | null;
  note: string;
}

/** Adresy sprawdzone w dokumentacji dostawców 2026-09-26 (patrz D-030). */
export const MODEL_PROVIDER_PRESETS: readonly ModelProviderPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    name: 'anthropic',
    kind: 'anthropic',
    baseUrl: null,
    keysUrl: 'https://platform.claude.com/settings/keys',
    pricingUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    note: 'Klucz z Claude Console (sk-ant-…).',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    name: 'openai',
    kind: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
    keysUrl: 'https://platform.openai.com/api-keys',
    pricingUrl: 'https://openai.com/api/pricing/',
    note: 'Klucz projektu z platformy OpenAI.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    name: 'gemini',
    kind: 'openai_compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keysUrl: 'https://aistudio.google.com/apikey',
    pricingUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    note: 'Klucz Gemini API z Google AI Studio (warstwa zgodności z OpenAI, wersja beta).',
  },
  {
    id: 'custom',
    label: 'Inny (zgodny z OpenAI)',
    name: '',
    kind: 'openai_compatible',
    baseUrl: null,
    keysUrl: null,
    pricingUrl: null,
    note: 'Dowolny serwer z /chat/completions (np. Mistral, OpenRouter, Ollama na localhost).',
  },
];

const LOCAL_BASE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?(\/|$)/;

/** Adres serwera: https:// albo lokalny http://localhost (bez loginu/hasła w adresie). */
export function safeBaseUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.protocol !== 'https:' && !LOCAL_BASE.test(u.toString())) return null;
  return u.toString().replace(/\/+$/, '');
}
export const isLocalBaseUrl = (url: string | null | undefined) => !!url && LOCAL_BASE.test(url);

export const ProviderName = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9_-]{1,39}$/,
    'Nazwa: małe litery, cyfry, „-” lub „_”, 2–40 znaków, zaczyna się literą',
  );
const Label = z.string().trim().min(1, 'Podaj nazwę wyświetlaną').max(80);
const BaseUrl = z
  .string()
  .trim()
  .max(300)
  .refine(
    (v) => safeBaseUrl(v) !== null,
    'Adres serwera: https:// albo http://localhost, bez loginu, hasła ani parametrów',
  )
  .transform((v) => safeBaseUrl(v)!);
/** Klucz API: bez spacji, rozsądna długość. Nigdy nie wraca w odpowiedzi. */
const ApiKey = z
  .string()
  .trim()
  .refine((v) => v.length >= 20 && v.length <= 400, 'Klucz API wygląda na niepełny (20–400 znaków)')
  .refine(
    (v) => /^[\x21-\x7e]*$/.test(v),
    'Klucz API nie może zawierać spacji ani polskich znaków',
  );

export const CreateModelProvider = z.object({
  name: ProviderName,
  label: Label,
  kind: ModelProviderKind,
  baseUrl: BaseUrl.nullable().optional(),
  apiKey: ApiKey.optional(),
  enabled: z.boolean().optional(),
});
export type CreateModelProvider = z.infer<typeof CreateModelProvider>;

export const UpdateModelProvider = z
  .object({
    label: Label.optional(),
    baseUrl: BaseUrl.nullable().optional(),
    /** Nowy klucz (zastępuje poprzedni). */
    apiKey: ApiKey.optional(),
    removeKey: z.literal(true).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => !(v.apiKey && v.removeKey), 'Podaj nowy klucz albo usuń obecny — nie oba naraz');
export type UpdateModelProvider = z.infer<typeof UpdateModelProvider>;

export const ModelKey = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9_.-]{1,59}$/,
    'Nazwa modelu w NovaAI: małe litery, cyfry, „.”, „-”, „_”, 2–60 znaków',
  );
const Price = z.number().min(0).max(100_000);
const CurrencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isCurrency, 'Nieznany kod waluty (ISO 4217, np. USD, EUR, PLN)');

export const ModelPricingInput = z.object({
  currency: CurrencyCode,
  /** Cena za milion tokenów wejścia/wyjścia (oficjalny cennik dostawcy). */
  inputPerMTok: Price,
  outputPerMTok: Price,
  cacheReadPerMTok: Price.nullable().optional(),
  cacheWritePerMTok: Price.nullable().optional(),
  /** Wyszukiwanie w internecie (Anthropic): cena za 1000 wyszukań; puste = wyłączone. */
  webSearchPer1k: Price.nullable().optional(),
  source: z.string().trim().max(300).nullable().optional(),
  verifiedAt: z.iso.date().nullable().optional(),
});
export type ModelPricingInput = z.infer<typeof ModelPricingInput>;

const ModelFields = {
  name: ModelKey,
  model: z
    .string()
    .trim()
    .min(1, 'Podaj identyfikator modelu u dostawcy')
    .max(120)
    .regex(/^[\x21-\x7e]+$/, 'Identyfikator modelu bez spacji'),
  maxTokens: z.number().int().min(16).max(128_000),
  dataPolicy: ModelDataPolicy,
  pricing: ModelPricingInput,
  useSimple: z.boolean(),
  useComplex: z.boolean(),
  priority: z.number().int().min(0).max(1000),
  enabled: z.boolean(),
};
export const CreateHouseholdModel = z
  .object({
    ...ModelFields,
    /** Dostawca dodany w aplikacji… */
    providerId: z.uuid().optional(),
    /** …albo dostawca z konfiguracji serwera (klucz w .env) — po nazwie. */
    serverProvider: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_.-]{1,60}$/, 'Nieprawidłowy dostawca serwera')
      .optional(),
    maxTokens: ModelFields.maxTokens.default(4000),
    dataPolicy: ModelFields.dataPolicy.default('private_ok'),
    useSimple: ModelFields.useSimple.default(true),
    useComplex: ModelFields.useComplex.default(true),
    priority: ModelFields.priority.default(100),
    enabled: ModelFields.enabled.default(true),
  })
  .refine((v) => v.useSimple || v.useComplex, 'Wybierz co najmniej jedno zastosowanie modelu')
  .refine((v) => !v.providerId !== !v.serverProvider, 'Wybierz dostawcę modelu');
export type CreateHouseholdModel = z.infer<typeof CreateHouseholdModel>;

export const UpdateHouseholdModel = z.object({
  model: ModelFields.model.optional(),
  maxTokens: ModelFields.maxTokens.optional(),
  dataPolicy: ModelFields.dataPolicy.optional(),
  pricing: ModelPricingInput.optional(),
  useSimple: z.boolean().optional(),
  useComplex: z.boolean().optional(),
  priority: ModelFields.priority.optional(),
  enabled: z.boolean().optional(),
});
export type UpdateHouseholdModel = z.infer<typeof UpdateHouseholdModel>;

export const SetFxRate = z.object({
  currency: CurrencyCode,
  /** 1 jednostka waluty cennika = `rate` waluty budżetu. null usuwa kurs. */
  rate: z.number().gt(0).lt(1_000_000).nullable(),
});
export type SetFxRate = z.infer<typeof SetFxRate>;

export interface ModelProviderInfo {
  id: string;
  name: string;
  label: string;
  kind: ModelProviderKind;
  baseUrl: string | null;
  hasKey: boolean;
  /** Ostatnie 4 znaki klucza (np. „…a1B2”) — nigdy cały klucz. */
  keyHint: string | null;
  enabled: boolean;
  /** Czy asystent może używać tego dostawcy (klucz, adres, odszyfrowanie). */
  usable: boolean;
  reason: string | null;
  lastCheck: { at: string; ok: boolean; message: string | null } | null;
  modelCount: number;
  /** Zastępuje (dla tego domu) dostawcę o tej samej nazwie z konfiguracji serwera. */
  overridesServer: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HouseholdModelInfo {
  id: string;
  /** null, gdy model korzysta z dostawcy z konfiguracji serwera (klucz w .env). */
  providerId: string | null;
  providerName: string;
  serverProvider: boolean;
  /** Zastępuje (dla tego domu) model o tej samej nazwie z konfiguracji serwera. */
  overridesServer: boolean;
  name: string;
  model: string;
  maxTokens: number;
  dataPolicy: ModelDataPolicy;
  pricing: {
    currency: string;
    inputPerMTok: number;
    outputPerMTok: number;
    cacheReadPerMTok: number | null;
    cacheWritePerMTok: number | null;
    webSearchPer1k: number | null;
    source: string | null;
    verifiedAt: string | null;
  };
  useSimple: boolean;
  useComplex: boolean;
  priority: number;
  enabled: boolean;
  available: boolean;
  reason: string | null;
}

export interface FileModelInfo {
  key: string;
  provider: string;
  model: string;
  available: boolean;
  reason: string | null;
  /** Dom ma model o tej samej nazwie — używany jest model z aplikacji. */
  overridden: boolean;
}

/** Dostawca z pliku konfiguracyjnego serwera (klucz w zmiennej środowiskowej, np. z .env). */
export interface ServerProviderInfo {
  name: string;
  kind: 'anthropic' | 'openai_compatible' | 'fake';
  /** Nazwa zmiennej z kluczem (np. ANTHROPIC_API_KEY) — nigdy wartość. */
  keyEnv: string | null;
  /** Klucz wczytany i dostawca gotowy (bez zastąpienia przez aplikację). */
  usable: boolean;
  reason: string | null;
  /** Dom dodał w aplikacji dostawcę o tej nazwie — używany jest ten z aplikacji. */
  overridden: boolean;
}

export interface ModelsOverview {
  /** Tylko właściciel domu dodaje i zmienia dostawców; domownik widzi stan. */
  canManage: boolean;
  /** Czy serwer ma NOVA_SECRET_KEY (bez niego nie da się zapisać klucza API). */
  vaultReady: boolean;
  /** Waluta budżetu (koszty modeli liczone są w niej). */
  currency: string;
  mode: 'configured' | 'demo';
  presets: readonly ModelProviderPreset[];
  providers: ModelProviderInfo[];
  models: HouseholdModelInfo[];
  /** Dostawcy i modele z pliku konfiguracyjnego serwera (tylko do odczytu; aplikacja ma pierwszeństwo). */
  serverProviders: ServerProviderInfo[];
  fileModels: FileModelInfo[];
  fx: Array<{ currency: string; rate: number; updatedAt: string }>;
  /** Waluty cenników bez kursu do waluty budżetu (model niedostępny, dopóki nie podasz kursu). */
  missingFx: string[];
}

export interface ProviderCheckResult {
  ok: boolean;
  message: string;
  /** Identyfikatory modeli zwrócone przez dostawcę (do podpowiedzi w formularzu). */
  models: string[];
}
