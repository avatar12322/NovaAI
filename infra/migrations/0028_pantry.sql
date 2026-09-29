-- 0028: spiżarnia domu (lodówka, zamrażarka, szafka) — stan szacowany: „masz / kończy się / raczej nie masz”
-- z daty zakupu i przewidywanej trwałości (uczonej z tego, jak szybko rzeczy schodzą). Dania z przepisów
-- zużywają składniki (zakładane po 3 dniach albo gdy użytkownik powie, że ugotował). Na liście zakupów
-- pozycje „pewnie masz — sprawdź” (maybe). Wszystko wspólne dla domowników (RLS jak lista zakupów).
CREATE TABLE pantry_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  name_key     text NOT NULL CHECK (length(name_key) BETWEEN 1 AND 120),
  place        text NOT NULL CHECK (place IN ('lodowka', 'zamrazarka', 'szafka')),
  shelf_days   int NOT NULL CHECK (shelf_days BETWEEN 1 AND 3650),
  stocked_at   timestamptz NOT NULL DEFAULT now(),
  used_up_at   timestamptz,
  added_by     uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, name_key)
);

ALTER TABLE pantry_items ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON pantry_items TO nova_app;
GRANT UPDATE (name, place, shelf_days, stocked_at, used_up_at) ON pantry_items TO nova_app;
CREATE POLICY pantry_items_select ON pantry_items FOR SELECT TO nova_app
  USING (nova_is_member(household_id));
CREATE POLICY pantry_items_insert ON pantry_items FOR INSERT TO nova_app
  WITH CHECK (added_by = nova_uid() AND nova_is_member(household_id));
CREATE POLICY pantry_items_update ON pantry_items FOR UPDATE TO nova_app
  USING (nova_is_member(household_id)) WITH CHECK (nova_is_member(household_id));
CREATE POLICY pantry_items_delete ON pantry_items FOR DELETE TO nova_app
  USING (nova_is_member(household_id));

CREATE TABLE meals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id),
  title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  uses         text[] NOT NULL DEFAULT '{}' CHECK (cardinality(uses) <= 60),
  planned_at   timestamptz NOT NULL DEFAULT now(),
  cooked_at    timestamptz,
  added_by     uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meals_pending_idx ON meals (household_id, planned_at) WHERE cooked_at IS NULL;

ALTER TABLE meals ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON meals TO nova_app;
GRANT UPDATE (planned_at, cooked_at) ON meals TO nova_app;
CREATE POLICY meals_select ON meals FOR SELECT TO nova_app USING (nova_is_member(household_id));
CREATE POLICY meals_insert ON meals FOR INSERT TO nova_app
  WITH CHECK (added_by = nova_uid() AND nova_is_member(household_id));
CREATE POLICY meals_update ON meals FOR UPDATE TO nova_app
  USING (nova_is_member(household_id)) WITH CHECK (nova_is_member(household_id));
CREATE POLICY meals_delete ON meals FOR DELETE TO nova_app USING (nova_is_member(household_id));

ALTER TABLE shopping_items ADD COLUMN maybe boolean NOT NULL DEFAULT false;
GRANT UPDATE (maybe) ON shopping_items TO nova_app;
