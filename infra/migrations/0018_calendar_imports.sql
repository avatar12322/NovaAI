-- 0018: kalendarze wgrane z pliku .ics (np. plan zajęć z dziekanatu). Wydarzenia trafiają do kalendarza lokalnego
-- właściciela (przegląd dnia, zajętość, odczyt przez prywatnego asystenta). Tylko właściciel widzi i zmienia.
CREATE TABLE calendar_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  event_count   integer NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calendar_imports_owner_idx ON calendar_imports (owner_user_id);

ALTER TABLE local_calendar_events
  ADD COLUMN import_id uuid REFERENCES calendar_imports(id) ON DELETE CASCADE,
  ADD COLUMN location  text CHECK (length(location) <= 200),
  ADD COLUMN notes     text CHECK (length(notes) <= 500);
CREATE INDEX local_calendar_events_import_idx ON local_calendar_events (import_id);

ALTER TABLE calendar_imports ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_imports TO nova_app;
CREATE POLICY calendar_imports_select ON calendar_imports FOR SELECT TO nova_app
  USING (nova_scope() = 'user' AND owner_user_id = nova_uid());
CREATE POLICY calendar_imports_insert ON calendar_imports FOR INSERT TO nova_app
  WITH CHECK (owner_user_id = nova_uid() AND nova_is_member(household_id));
CREATE POLICY calendar_imports_update ON calendar_imports FOR UPDATE TO nova_app
  USING (nova_scope() = 'user' AND owner_user_id = nova_uid())
  WITH CHECK (owner_user_id = nova_uid());
CREATE POLICY calendar_imports_delete ON calendar_imports FOR DELETE TO nova_app
  USING (nova_scope() = 'user' AND owner_user_id = nova_uid());
