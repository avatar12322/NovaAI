/** Konfiguracja testów — lokalny klaster dev (scripts/pg-local.sh) lub Compose, baza nova_test. */
export const TEST_ENV = {
  NOVA_ENV: 'test',
  DATABASE_URL_APP:
    process.env.TEST_DATABASE_URL_APP ??
    'postgres://nova_app:nova_app_dev@127.0.0.1:54329/nova_test',
  DATABASE_URL_OWNER:
    process.env.TEST_DATABASE_URL_OWNER ??
    'postgres://nova_owner:nova_owner_dev@127.0.0.1:54329/nova_test',
  NOVA_DEV_LOGIN: 'true',
  NOVA_WEB_ORIGIN: 'http://localhost:5173',
  NOVA_QUEUE_ENABLED: 'false',
  NOVA_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
  NOVA_MODELS_CONFIG: '',
} as const;
