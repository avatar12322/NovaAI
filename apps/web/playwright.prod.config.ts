import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke produkcyjny: zbudowany frontend (apps/web/dist) serwowany przez bundel API (apps/api/dist)
 * z NOVA_ENV=production — bez logowania testowego, z CSP i ciasteczkami Secure. Baza nova_e2e.
 * Uruchom: `pnpm test:prod-smoke` (buduje oba artefakty).
 */
export const PROD_PORT = 4200;
export const PROD_BASE = `http://localhost:${PROD_PORT}`;
const db = (role: string, pass: string) => `postgres://${role}:${pass}@127.0.0.1:54329/nova_e2e`;

export const PROD_ENV: Record<string, string> = {
  NOVA_ENV: 'production',
  NOVA_DEV_LOGIN: 'false',
  NOVA_API_HOST: '127.0.0.1',
  NOVA_API_PORT: String(PROD_PORT),
  NOVA_WEB_ORIGIN: PROD_BASE,
  NOVA_PUBLIC_URL: PROD_BASE,
  NOVA_RP_ID: 'localhost',
  NOVA_RP_ORIGINS: PROD_BASE,
  NOVA_WEB_DIST: 'apps/web/dist',
  NOVA_MODELS_CONFIG: '',
  NOVA_QUEUE_ENABLED: 'true',
  // Klucz jednorazowy dla tego przebiegu (baza e2e jest resetowana).
  NOVA_SECRET_KEY: process.env.NOVA_PROD_SMOKE_KEY ?? randomBytes(32).toString('base64'),
  DATABASE_URL_APP: db('nova_app', 'nova_app_dev'),
  DATABASE_URL_OWNER: db('nova_owner', 'nova_owner_dev'),
};
process.env.NOVA_PROD_SMOKE_KEY = PROD_ENV.NOVA_SECRET_KEY;

export default defineConfig({
  testDir: './e2e-prod',
  timeout: 30_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: PROD_BASE,
    trace: 'retain-on-failure',
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    // reset-e2e odmawia pracy w produkcji — baza jest czyszczona w trybie test, serwer startuje jako produkcja.
    command:
      'NOVA_ENV=test node apps/api/dist/cli.js reset-e2e && exec node --enable-source-maps apps/api/dist/main.js',
    cwd: '../..',
    url: `${PROD_BASE}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: PROD_ENV,
  },
});
