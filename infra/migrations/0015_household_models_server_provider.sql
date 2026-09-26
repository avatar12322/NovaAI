-- 0015: model dodany w aplikacji może korzystać z dostawcy z konfiguracji serwera (klucz w .env),
-- bez ponownego wpisywania klucza. Dokładnie jedno źródło: dostawca domu albo dostawca serwera (po nazwie).
ALTER TABLE household_models ALTER COLUMN provider_id DROP NOT NULL;
ALTER TABLE household_models ADD COLUMN server_provider text
  CHECK (server_provider IS NULL OR server_provider ~ '^[A-Za-z0-9_.-]{1,60}$');
ALTER TABLE household_models ADD CONSTRAINT household_models_one_provider
  CHECK ((provider_id IS NULL) <> (server_provider IS NULL));
