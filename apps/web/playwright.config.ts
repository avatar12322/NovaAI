import { defineConfig, devices } from '@playwright/test';

/**
 * E2E: API na osobnej bazie nova_e2e (resetowanej przy starcie) + Vite dev server.
 * Wymaga działającego Postgresa (pnpm db:start lub Compose). Chromium: preinstalowany
 * (PLAYWRIGHT_BROWSERS_PATH) albo `npx playwright install chromium` lokalnie.
 */
const API_PORT = 4100;
const WEB_PORT = 5174;
const e2eDb = (role: string, pass: string) => `postgres://${role}:${pass}@127.0.0.1:54329/nova_e2e`;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 860 } },
    },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: 'pnpm --filter @nova/api start:e2e',
      cwd: '../..',
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NOVA_ENV: 'test',
        NOVA_API_PORT: String(API_PORT),
        NOVA_WEB_ORIGIN: `http://127.0.0.1:${WEB_PORT}`,
        DATABASE_URL_APP: e2eDb('nova_app', 'nova_app_dev'),
        DATABASE_URL_OWNER: e2eDb('nova_owner', 'nova_owner_dev'),
        NOVA_DEV_LOGIN: 'true',
        NOVA_QUEUE_ENABLED: 'true',
        NOVA_MODELS_CONFIG: '',
        // WebAuthn wymaga domeny (nie IP) — testy passkeys używają http://localhost:5174.
        NOVA_RP_ID: 'localhost',
        NOVA_RP_ORIGINS: `http://localhost:${WEB_PORT}`,
        NOVA_PUBLIC_URL: `http://localhost:${WEB_PORT}`,
        // Sejf tokenów i klienci Microsoft/Slack wyłącznie testowe: integracje są „skonfigurowane”, ale żadne
        // konto nie jest połączone, a przekierowania do logowania przechwytuje sama przeglądarka.
        NOVA_SECRET_KEY: Buffer.alloc(32, 9).toString('base64'),
        NOVA_SECRET_KEY_ID: 'e2e',
        MICROSOFT_CLIENT_ID: 'e2e-client-id',
        MICROSOFT_CLIENT_SECRET: 'e2e-client-secret',
        SLACK_CLIENT_ID: 'e2e-slack-client',
        SLACK_CLIENT_SECRET: 'e2e-slack-secret',
      },
    },
    {
      command: `pnpm exec vite --port ${WEB_PORT} --strictPort`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { NOVA_API_URL: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
