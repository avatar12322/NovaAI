-- 0005: budżet i rzeczywiste zużycie modeli.
-- Kwoty w mikro-jednostkach waluty budżetu (1 PLN = 1 000 000 mikro), bez zaokrągleń zmiennoprzecinkowych.

CREATE TABLE budgets (
  household_id       uuid PRIMARY KEY REFERENCES households(id),
  currency           text NOT NULL DEFAULT 'PLN',
  soft_limit_micros  bigint CHECK (soft_limit_micros >= 0),
  hard_limit_micros  bigint CHECK (hard_limit_micros >= 0),
  paid_calls_enabled boolean NOT NULL DEFAULT true,
  updated_by         uuid REFERENCES users(id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Rezerwacja przed płatnym wywołaniem (najgorszy przypadek) jest rozliczana po odpowiedzi.
-- Rezerwacje wliczają się do limitu, więc równoległe wywołania nie przekroczą twardego limitu.
CREATE TABLE usage_records (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id       uuid NOT NULL REFERENCES households(id),
  owner_user_id      uuid REFERENCES users(id),
  task_id            uuid REFERENCES tasks(id) ON DELETE SET NULL,
  conversation_id    uuid REFERENCES conversations(id) ON DELETE SET NULL,
  provider           text NOT NULL,
  model              text NOT NULL,
  capability         text NOT NULL,
  status             text NOT NULL CHECK (status IN ('reserved', 'final', 'failed')),
  input_tokens       int NOT NULL DEFAULT 0,
  output_tokens      int NOT NULL DEFAULT 0,
  cache_read_tokens  int NOT NULL DEFAULT 0,
  cache_write_tokens int NOT NULL DEFAULT 0,
  cost_micros        bigint NOT NULL DEFAULT 0,
  currency           text NOT NULL,
  estimated          boolean NOT NULL DEFAULT false,
  paid               boolean NOT NULL DEFAULT true,
  price_source       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  settled_at         timestamptz
);
CREATE INDEX usage_records_household_month_idx ON usage_records (household_id, created_at);

ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON budgets TO nova_app;
CREATE POLICY budgets_select ON budgets FOR SELECT TO nova_app USING (nova_is_member(household_id));

-- Zużycie jest informacją domową (koszt), bez treści rozmów.
ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON usage_records TO nova_app;
CREATE POLICY usage_records_select ON usage_records FOR SELECT TO nova_app USING (nova_is_member(household_id));
