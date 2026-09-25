-- 0008: przypomnienia — deterministyczne, planowane przez trwałą kolejkę (run_after), bez modelu i poczty.

CREATE TABLE reminders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  visibility    text NOT NULL CHECK (visibility IN ('private', 'shared')),
  text          text NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  due_at        timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'fired', 'cancelled')),
  task_id       uuid REFERENCES tasks(id) ON DELETE SET NULL,
  source        text NOT NULL DEFAULT 'user',
  created_at    timestamptz NOT NULL DEFAULT now(),
  fired_at      timestamptz,
  cancelled_at  timestamptz
);
CREATE INDEX reminders_owner_idx ON reminders (owner_user_id, due_at);
CREATE INDEX reminders_household_idx ON reminders (household_id, visibility, due_at);

ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON reminders TO nova_app;
CREATE POLICY reminders_select ON reminders FOR SELECT TO nova_app
  USING (nova_can_see(owner_user_id, household_id, visibility));
CREATE POLICY reminders_insert ON reminders FOR INSERT TO nova_app
  WITH CHECK (owner_user_id = nova_uid() AND nova_is_member(household_id));
CREATE POLICY reminders_update ON reminders FOR UPDATE TO nova_app
  USING (owner_user_id = nova_uid() AND nova_scope() = 'user')
  WITH CHECK (owner_user_id = nova_uid());
