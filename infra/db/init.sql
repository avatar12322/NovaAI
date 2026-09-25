-- Jednorazowa inicjalizacja klastra (uruchamia superużytkownik).
-- Idempotentne. Hasła poniżej są WYŁĄCZNIE dla lokalnego dev/test na loopbacku.
-- W produkcji utwórz role z własnymi, losowymi hasłami poza repozytorium.
--
-- nova_owner: właściciel schematu, uruchamia migracje i operacje systemowe (kolejka, sesje, audyt).
-- nova_app:   rola zapytań w kontekście użytkownika; podlega Row Level Security (NOBYPASSRLS).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_owner') THEN
    CREATE ROLE nova_owner LOGIN PASSWORD 'nova_owner_dev' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
    CREATE ROLE nova_app LOGIN PASSWORD 'nova_app_dev' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

SELECT 'CREATE DATABASE nova_dev OWNER nova_owner'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'nova_dev') \gexec

SELECT 'CREATE DATABASE nova_test OWNER nova_owner'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'nova_test') \gexec

GRANT CONNECT ON DATABASE nova_dev TO nova_app;
GRANT CONNECT ON DATABASE nova_test TO nova_app;

SELECT 'CREATE DATABASE nova_e2e OWNER nova_owner'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'nova_e2e') \gexec
GRANT CONNECT ON DATABASE nova_e2e TO nova_app;
