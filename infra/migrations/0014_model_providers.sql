-- 0014: dostawcy modeli i klucze API dodawane w aplikacji (obok models.local.json + zmiennych środowiskowych).
-- Klucze wyłącznie zaszyfrowane (AES-256-GCM, NOVA_SECRET_KEY), tylko do zapisu: API zwraca co najwyżej ostatnie
-- 4 znaki. Rola aplikacji (nova_app) nie ma prawa odczytu kolumny z szyfrogramem. Zmienia właściciel domu.

CREATE TABLE model_providers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id       uuid NOT NULL REFERENCES households(id),
  -- Nazwa używana w trasach, w usage_records.provider i w „Usługi i koszty” (np. 'anthropic', 'gemini').
  name               text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_-]{1,39}$'),
  label              text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  kind               text NOT NULL CHECK (kind IN ('anthropic', 'openai_compatible')),
  -- HTTPS albo lokalny serwer (np. Ollama na localhost).
  base_url           text CHECK (base_url IS NULL OR (length(base_url) <= 300 AND
                       (base_url ~ '^https://[^/@\s]+' OR base_url ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?(/|$)'))),
  key_ciphertext     bytea,
  key_id             text,
  key_hint           text CHECK (length(key_hint) <= 8),
  enabled            boolean NOT NULL DEFAULT true,
  last_check_at      timestamptz,
  last_check_ok      boolean,
  last_check_message text CHECK (length(last_check_message) <= 300),
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, name)
);

-- Modele udostępniane asystentowi z cennikiem (bez cennika model płatny jest niedostępny — budżet).
CREATE TABLE household_models (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id         uuid NOT NULL REFERENCES households(id),
  provider_id          uuid NOT NULL REFERENCES model_providers(id) ON DELETE CASCADE,
  name                 text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9_.-]{1,59}$'),
  model                text NOT NULL CHECK (length(model) BETWEEN 1 AND 120),
  max_tokens           integer NOT NULL DEFAULT 4000 CHECK (max_tokens BETWEEN 16 AND 128000),
  data_policy          text NOT NULL DEFAULT 'private_ok' CHECK (data_policy IN ('private_ok', 'shared_only')),
  price_currency       text NOT NULL CHECK (price_currency ~ '^[A-Z]{3}$'),
  input_per_mtok       numeric NOT NULL CHECK (input_per_mtok >= 0),
  output_per_mtok      numeric NOT NULL CHECK (output_per_mtok >= 0),
  cache_read_per_mtok  numeric CHECK (cache_read_per_mtok >= 0),
  cache_write_per_mtok numeric CHECK (cache_write_per_mtok >= 0),
  pricing_source       text CHECK (length(pricing_source) <= 300),
  pricing_verified_at  date,
  use_simple           boolean NOT NULL DEFAULT true,
  use_complex          boolean NOT NULL DEFAULT true,
  priority             integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
  enabled              boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, name)
);

-- Kursy walut cenników do waluty budżetu (ustawia właściciel; brak kursu => model niedostępny).
CREATE TABLE household_fx (
  household_id uuid NOT NULL REFERENCES households(id),
  currency     text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  rate         numeric NOT NULL CHECK (rate > 0 AND rate < 1000000),
  updated_by   uuid NOT NULL REFERENCES users(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, currency)
);

ALTER TABLE model_providers ENABLE ROW LEVEL SECURITY;
GRANT SELECT (id, household_id, name, label, kind, base_url, key_hint, enabled, last_check_at, last_check_ok,
              last_check_message, created_by, created_at, updated_at) ON model_providers TO nova_app;
CREATE POLICY model_providers_select ON model_providers FOR SELECT TO nova_app USING (nova_is_member(household_id));

ALTER TABLE household_models ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON household_models TO nova_app;
CREATE POLICY household_models_select ON household_models FOR SELECT TO nova_app USING (nova_is_member(household_id));

ALTER TABLE household_fx ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON household_fx TO nova_app;
CREATE POLICY household_fx_select ON household_fx FOR SELECT TO nova_app USING (nova_is_member(household_id));
