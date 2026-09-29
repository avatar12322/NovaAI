-- 0025: wydatki domu (wspólne) i osobiste (prywatne) oraz stałe płatności i raty z odhaczaniem „zapłacone”.
CREATE TABLE recurring_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  visibility    text NOT NULL CHECK (visibility IN ('private', 'shared')),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  amount        numeric(12, 2) NOT NULL CHECK (amount > 0 AND amount < 10000000),
  currency      text NOT NULL DEFAULT 'PLN' CHECK (currency ~ '^[A-Z]{3}$'),
  category      text NOT NULL DEFAULT 'raty',
  day_of_month  int NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  starts_on     date NOT NULL DEFAULT current_date,
  -- Ostatnia płatność (np. ostatnia rata); NULL — bez końca (abonament, czynsz).
  ends_on       date,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX recurring_payments_household_idx ON recurring_payments (household_id, active);

CREATE TABLE expenses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  visibility    text NOT NULL CHECK (visibility IN ('private', 'shared')),
  amount        numeric(12, 2) NOT NULL CHECK (amount > 0 AND amount < 10000000),
  currency      text NOT NULL DEFAULT 'PLN' CHECK (currency ~ '^[A-Z]{3}$'),
  category      text NOT NULL,
  description   text NOT NULL DEFAULT '' CHECK (length(description) <= 200),
  spent_on      date NOT NULL,
  source        text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'assistant', 'payment')),
  -- Zapłacona rata / stała płatność: jedna na miesiąc (pierwszy dzień miesiąca).
  payment_id    uuid REFERENCES recurring_payments(id) ON DELETE SET NULL,
  payment_month date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, payment_month)
);
CREATE INDEX expenses_household_idx ON expenses (household_id, spent_on);

ALTER TABLE recurring_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON recurring_payments, expenses TO nova_app;
GRANT UPDATE (name, amount, day_of_month, ends_on, active) ON recurring_payments TO nova_app;

CREATE POLICY recurring_payments_select ON recurring_payments FOR SELECT TO nova_app
  USING (nova_can_see(owner_user_id, household_id, visibility));
CREATE POLICY recurring_payments_insert ON recurring_payments FOR INSERT TO nova_app
  WITH CHECK (owner_user_id = nova_uid() AND nova_is_member(household_id));
CREATE POLICY recurring_payments_update ON recurring_payments FOR UPDATE TO nova_app
  USING (owner_user_id = nova_uid()) WITH CHECK (owner_user_id = nova_uid());
CREATE POLICY recurring_payments_delete ON recurring_payments FOR DELETE TO nova_app
  USING (owner_user_id = nova_uid());

CREATE POLICY expenses_select ON expenses FOR SELECT TO nova_app
  USING (nova_can_see(owner_user_id, household_id, visibility));
-- Wydatek z płatności: tylko z płatności widocznej dla autora (także wspólnej rodziny).
CREATE POLICY expenses_insert ON expenses FOR INSERT TO nova_app
  WITH CHECK (owner_user_id = nova_uid() AND nova_is_member(household_id));
CREATE POLICY expenses_delete ON expenses FOR DELETE TO nova_app
  USING (owner_user_id = nova_uid());
