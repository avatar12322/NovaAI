-- 0004: postęp zadań, idempotencja powiadomień, NOTIFY dla strumienia zdarzeń.

ALTER TABLE tasks ADD COLUMN progress smallint CHECK (progress BETWEEN 0 AND 100);
ALTER TABLE task_steps ADD COLUMN progress smallint CHECK (progress BETWEEN 0 AND 100);
ALTER TABLE approvals ADD COLUMN reason text;

-- Każde powiadomienie wysłane przez narzędzie ma klucz idempotencji (np. execution_id zgody).
ALTER TABLE notifications ADD COLUMN idempotency_key text UNIQUE;

-- Po zatwierdzeniu transakcji z nowym zdarzeniem do słuchaczy trafia WYŁĄCZNIE jego identyfikator.
-- Serwer SSE pobiera zdarzenie ponownie w kontekście RLS odbiorcy — treść nie omija ACL.
CREATE FUNCTION events_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('nova_events', NEW.id::text);
  RETURN NEW;
END $$;
CREATE TRIGGER events_notify AFTER INSERT ON events FOR EACH ROW EXECUTE FUNCTION events_notify();

CREATE INDEX task_steps_task_idx ON task_steps (task_id, seq);
CREATE INDEX approvals_task_idx ON approvals (task_id);

-- Licznik utraconych dzierżaw (awaria/restart workera). Po przekroczeniu max_attempts zadanie => failed.
ALTER TABLE tasks ADD COLUMN lease_expirations int NOT NULL DEFAULT 0;
