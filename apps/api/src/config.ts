import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

export const REPO_ROOT = resolve(import.meta.dirname, '../../..');

const Bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NOVA_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NOVA_API_HOST: z.string().default('127.0.0.1'),
  NOVA_API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  NOVA_WEB_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL_APP: z.string().min(1),
  DATABASE_URL_OWNER: z.string().min(1),
  NOVA_DEV_LOGIN: Bool,
  NOVA_SECRET_KEY: z.string().optional().default(''),
  NOVA_SECRET_KEY_ID: z.string().default('k1'),
  NOVA_MODELS_CONFIG: z.string().optional().default(''),
  /** Dostawcy modeli dodani w aplikacji mogą wskazywać http://localhost (np. Ollama). Domyślnie: poza produkcją. */
  NOVA_MODELS_ALLOW_LOCAL: z.enum(['true', 'false', '1', '0', '']).optional(),
  NOVA_QUEUE_ENABLED: z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),
  NOVA_QUEUE_LEASE_MS: z.coerce.number().int().min(1000).default(30_000),
  NOVA_SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .default(24 * 14),
  NOVA_SECRET_KEYS_OLD: z.string().optional().default(''),
  NOVA_PUBLIC_URL: z.string().optional().default(''),
  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
  // Klucze administracyjne do odczytu raportów kosztów (Usługi i koszty). Puste => adapter „niepodłączony”.
  ANTHROPIC_ADMIN_API_KEY: z.string().optional().default(''),
  OPENAI_ADMIN_API_KEY: z.string().optional().default(''),
  // Głos ElevenLabs (odczyt odpowiedzi na głos). Pusty klucz => głos przeglądarki.
  ELEVENLABS_API_KEY: z.string().optional().default(''),
  ELEVENLABS_VOICE_ID: z
    .string()
    .regex(/^[A-Za-z0-9]{10,40}$/)
    .optional()
    .default('o2xdfKUpc1Bwq7RchZuW'),
  ELEVENLABS_MODEL_ID: z
    .string()
    .regex(/^[a-z0-9_]{3,40}$/)
    .optional()
    .default('eleven_flash_v2_5'),
  /** Miesięczny limit znaków na dom (0 = bez limitu po stronie NovaAI). */
  ELEVENLABS_MONTHLY_CHARS: z.coerce.number().int().min(0).default(30_000),
  SLACK_CLIENT_ID: z.string().optional().default(''),
  SLACK_CLIENT_SECRET: z.string().optional().default(''),
  MICROSOFT_CLIENT_ID: z.string().optional().default(''),
  MICROSOFT_CLIENT_SECRET: z.string().optional().default(''),
  // Katalog logowania: common (konta osobiste i służbowe), organizations, consumers albo identyfikator dzierżawy.
  MICROSOFT_TENANT: z
    .string()
    .regex(/^(common|organizations|consumers|[0-9a-fA-F-]{36}|[A-Za-z0-9.-]{1,100}\.[A-Za-z]{2,})$/)
    .optional()
    .default('common'),
  SLACK_SIGNING_SECRET: z.string().optional().default(''),
  NOVA_RP_ID: z.string().optional().default(''),
  NOVA_RP_NAME: z.string().optional().default('NovaAI'),
  NOVA_RP_ORIGINS: z.string().optional().default(''),
  /** Za reverse proxy: liczba zaufanych przeskoków (np. 1) — poprawne req.ip dla limitów. */
  NOVA_TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  /** Katalog zbudowanego frontendu (np. apps/web/dist) — API serwuje go z tego samego originu. */
  NOVA_WEB_DIST: z.string().optional().default(''),
});

export type AppConfig = {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  webOrigin: string;
  databaseUrlApp: string;
  databaseUrlOwner: string;
  devLogin: boolean;
  secretKey: string;
  secretKeyId: string;
  modelsConfigPath: string;
  /** Czy dostawca modeli dodany w aplikacji może wskazywać lokalny serwer (http://localhost). */
  modelsAllowLocal: boolean;
  queueEnabled: boolean;
  queueLeaseMs: number;
  sessionTtlMs: number;
  secureCookies: boolean;
  secretKeysOld: string;
  /** Publiczny adres aplikacji (redirect OAuth). Domyślnie NOVA_WEB_ORIGIN. */
  publicUrl: string;
  google: { clientId: string; clientSecret: string };
  microsoft: { clientId: string; clientSecret: string; tenant: string };
  slack: { clientId: string; clientSecret: string };
  costAdapterKeys: { anthropic: string; openai: string };
  /** Synteza mowy ElevenLabs; klucz tylko po stronie serwera. */
  tts: { apiKey: string; voiceId: string; modelId: string; monthlyChars: number };
  slackSigningSecret: string;
  /** WebAuthn: identyfikator RP (domena), nazwa i dozwolone originy. */
  webauthn: { rpId: string; rpName: string; origins: string[] };
  trustProxy: number;
  /** Bezwzględna ścieżka do zbudowanego frontendu lub '' (frontend serwowany osobno, np. Vite w dev). */
  webDist: string;
};

export class ConfigError extends Error {}

/** Ładuje .env z katalogu repo (jeśli istnieje) — bez nadpisywania już ustawionych zmiennych. */
export function loadDotEnv(): void {
  const file = resolve(REPO_ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

export function parseConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new ConfigError(`Nieprawidłowa konfiguracja środowiska: ${fields}`);
  }
  const e = parsed.data;
  // Twarda blokada: logowanie testowe nie może działać w produkcji.
  if (e.NOVA_ENV === 'production' && e.NOVA_DEV_LOGIN) {
    throw new ConfigError('NOVA_DEV_LOGIN=true jest zabronione przy NOVA_ENV=production');
  }
  if (e.NOVA_ENV === 'production' && e.NOVA_SECRET_KEY.length === 0) {
    throw new ConfigError('NOVA_SECRET_KEY jest wymagany w produkcji');
  }
  return {
    env: e.NOVA_ENV,
    host: e.NOVA_API_HOST,
    port: e.NOVA_API_PORT,
    webOrigin: e.NOVA_WEB_ORIGIN,
    databaseUrlApp: e.DATABASE_URL_APP,
    databaseUrlOwner: e.DATABASE_URL_OWNER,
    devLogin: e.NOVA_ENV !== 'production' && e.NOVA_DEV_LOGIN,
    secretKey: e.NOVA_SECRET_KEY,
    secretKeyId: e.NOVA_SECRET_KEY_ID,
    modelsConfigPath: e.NOVA_MODELS_CONFIG ? resolve(REPO_ROOT, e.NOVA_MODELS_CONFIG) : '',
    modelsAllowLocal:
      e.NOVA_MODELS_ALLOW_LOCAL === undefined || e.NOVA_MODELS_ALLOW_LOCAL === ''
        ? e.NOVA_ENV !== 'production'
        : e.NOVA_MODELS_ALLOW_LOCAL === 'true' || e.NOVA_MODELS_ALLOW_LOCAL === '1',
    queueEnabled: e.NOVA_QUEUE_ENABLED,
    queueLeaseMs: e.NOVA_QUEUE_LEASE_MS,
    sessionTtlMs: e.NOVA_SESSION_TTL_HOURS * 3600_000,
    secureCookies: e.NOVA_ENV === 'production',
    secretKeysOld: e.NOVA_SECRET_KEYS_OLD,
    publicUrl: (e.NOVA_PUBLIC_URL || e.NOVA_WEB_ORIGIN).replace(/\/$/, ''),
    google: { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET },
    microsoft: {
      clientId: e.MICROSOFT_CLIENT_ID,
      clientSecret: e.MICROSOFT_CLIENT_SECRET,
      tenant: e.MICROSOFT_TENANT,
    },
    slack: { clientId: e.SLACK_CLIENT_ID, clientSecret: e.SLACK_CLIENT_SECRET },
    costAdapterKeys: { anthropic: e.ANTHROPIC_ADMIN_API_KEY, openai: e.OPENAI_ADMIN_API_KEY },
    tts: {
      apiKey: e.ELEVENLABS_API_KEY,
      voiceId: e.ELEVENLABS_VOICE_ID,
      modelId: e.ELEVENLABS_MODEL_ID,
      monthlyChars: e.ELEVENLABS_MONTHLY_CHARS,
    },
    slackSigningSecret: e.SLACK_SIGNING_SECRET,
    webauthn: {
      rpId: e.NOVA_RP_ID || new URL(e.NOVA_WEB_ORIGIN).hostname,
      rpName: e.NOVA_RP_NAME,
      origins: (e.NOVA_RP_ORIGINS || e.NOVA_WEB_ORIGIN)
        .split(',')
        .map((o) => o.trim().replace(/\/$/, ''))
        .filter(Boolean),
    },
    trustProxy: e.NOVA_TRUST_PROXY,
    webDist: e.NOVA_WEB_DIST ? resolve(REPO_ROOT, e.NOVA_WEB_DIST) : '',
  };
}
