-- 0023: wspólna lista zakupów domu — każdy domownik dodaje, odhacza i usuwa pozycje (także przez asystenta).
CREATE TABLE shopping_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id),
  added_by     uuid NOT NULL REFERENCES users(id),
  text         text NOT NULL CHECK (length(text) BETWEEN 1 AND 200),
  checked_at   timestamptz,
  checked_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shopping_items_household_idx ON shopping_items (household_id, created_at);

ALTER TABLE shopping_items ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON shopping_items TO nova_app;
GRANT UPDATE (text, checked_at, checked_by) ON shopping_items TO nova_app;
CREATE POLICY shopping_items_select ON shopping_items FOR SELECT TO nova_app
  USING (nova_is_member(household_id));
CREATE POLICY shopping_items_insert ON shopping_items FOR INSERT TO nova_app
  WITH CHECK (added_by = nova_uid() AND nova_is_member(household_id));
CREATE POLICY shopping_items_update ON shopping_items FOR UPDATE TO nova_app
  USING (nova_is_member(household_id)) WITH CHECK (nova_is_member(household_id));
CREATE POLICY shopping_items_delete ON shopping_items FOR DELETE TO nova_app
  USING (nova_is_member(household_id));
