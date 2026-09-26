-- 0013: „Usługi i koszty” — rejestr usług używanych przez NovaAI (dostawcy modeli, VPS, bazy, domeny, kopie
-- zapasowe, abonamenty) z budżetem, odnowieniami i ręcznymi wpisami kosztów/faktur.
-- Widoczność jak w pozostałych danych: prywatna usługa — tylko właściciel; wspólna — członkowie domu (jawnie).
-- Bez haseł i kluczy: klucze administracyjne adapterów kosztów są wyłącznie w konfiguracji serwera.

CREATE TABLE services (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id          uuid NOT NULL REFERENCES households(id),
  owner_user_id         uuid NOT NULL REFERENCES users(id),
  visibility            text NOT NULL CHECK (visibility IN ('private', 'shared')),
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  category              text NOT NULL
                        CHECK (category IN ('model_api', 'vps', 'database', 'domain', 'backup', 'subscription', 'other')),
  purpose               text NOT NULL DEFAULT '' CHECK (length(purpose) <= 500),
  -- Tylko HTTPS, bez danych logowania w adresie (walidacja także w aplikacji).
  panel_url             text CHECK (panel_url IS NULL OR (length(panel_url) <= 500 AND panel_url ~ '^https://[^/@\s]+(/|$)')),
  billing_period        text NOT NULL CHECK (billing_period IN ('monthly', 'quarterly', 'yearly', 'one_time', 'usage')),
  currency              text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  plan                  text NOT NULL DEFAULT '' CHECK (length(plan) <= 120),
  renews_on             date,
  -- Dzień miesiąca ustawiony przez użytkownika: odnowienie 31.01 → 28/29.02 → 31.03 (bez „dryfu”).
  renewal_anchor_day    smallint CHECK (renewal_anchor_day BETWEEN 1 AND 31),
  remind_days_before    integer NOT NULL DEFAULT 7 CHECK (remind_days_before BETWEEN 0 AND 60),
  -- Kwoty w mikro-jednostkach waluty (jak usage_records): 1 PLN = 1 000 000.
  monthly_budget_micros bigint CHECK (monthly_budget_micros BETWEEN 0 AND 1000000000000000),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'trial', 'paused', 'cancelled')),
  -- Powiązanie z dostawcą modeli z konfiguracji (klucz dostawcy w usage_records) — źródło szacunków.
  model_provider        text CHECK (length(model_provider) BETWEEN 1 AND 60),
  -- Adapter raportu kosztów dostawcy (np. 'anthropic', 'openai').
  cost_adapter          text CHECK (cost_adapter IN ('anthropic', 'openai')),
  reminder_id           uuid REFERENCES reminders(id) ON DELETE SET NULL,
  notes                 text NOT NULL DEFAULT '' CHECK (length(notes) <= 1000),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX services_owner_idx ON services (owner_user_id, created_at DESC);
CREATE INDEX services_household_idx ON services (household_id, visibility);
-- Ten sam koszt nie może trafić do dwóch usług: dostawca modeli i adapter — najwyżej jedna usługa w domu.
CREATE UNIQUE INDEX services_model_provider_uq ON services (household_id, model_provider) WHERE model_provider IS NOT NULL;
CREATE UNIQUE INDEX services_cost_adapter_uq ON services (household_id, cost_adapter) WHERE cost_adapter IS NOT NULL;

-- Wpisy kosztów: szacunek, raport dostawcy albo faktura (opłacona, gdy paid_on). W sumie miesiąca liczy się
-- jedno źródło na usługę i miesiąc: faktura > raport dostawcy > szacunek (aplikacja; opis w DECISIONS D-029).
CREATE TABLE service_costs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id     uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('estimate', 'report', 'invoice')),
  month          date NOT NULL CHECK (extract(day FROM month) = 1),
  amount_micros  bigint NOT NULL CHECK (amount_micros BETWEEN 0 AND 1000000000000000),
  currency       text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  description    text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  invoice_number text CHECK (length(invoice_number) BETWEEN 1 AND 80),
  issued_on      date,
  paid_on        date,
  source         text NOT NULL CHECK (source ~ '^(manual|import|adapter:[a-z]+)$'),
  -- Klucz deduplikacji: numer faktury, (data, kwota, waluta) faktury bez numeru, miesiąc raportu adaptera.
  dedupe_key     text NOT NULL CHECK (length(dedupe_key) <= 200),
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'invoice' OR (invoice_number IS NULL AND paid_on IS NULL)),
  UNIQUE (service_id, dedupe_key)
);
CREATE INDEX service_costs_month_idx ON service_costs (service_id, month);

-- Stan synchronizacji adapterów (dom × adapter). Tylko rola właściciela; do UI trafia bez sekretów.
CREATE TABLE cost_adapter_runs (
  household_id    uuid NOT NULL REFERENCES households(id),
  adapter         text NOT NULL,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error      text CHECK (length(last_error) <= 300),
  PRIMARY KEY (household_id, adapter)
);

ALTER TABLE services ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON services TO nova_app;
CREATE POLICY services_select ON services FOR SELECT TO nova_app
  USING (nova_can_see(owner_user_id, household_id, visibility));
CREATE POLICY services_insert ON services FOR INSERT TO nova_app
  WITH CHECK (owner_user_id = nova_uid() AND nova_scope() = 'user' AND nova_is_member(household_id));
CREATE POLICY services_update ON services FOR UPDATE TO nova_app
  USING (owner_user_id = nova_uid() AND nova_scope() = 'user')
  WITH CHECK (owner_user_id = nova_uid());
CREATE POLICY services_delete ON services FOR DELETE TO nova_app
  USING (owner_user_id = nova_uid() AND nova_scope() = 'user');

-- Wpisy widoczne razem z usługą (podzapytanie podlega RLS tabeli services); zapis tylko właściciel usługi.
ALTER TABLE service_costs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON service_costs TO nova_app;
CREATE POLICY service_costs_select ON service_costs FOR SELECT TO nova_app
  USING (EXISTS (SELECT 1 FROM services s WHERE s.id = service_id));
CREATE POLICY service_costs_insert ON service_costs FOR INSERT TO nova_app
  WITH CHECK (created_by = nova_uid() AND nova_scope() = 'user'
    AND EXISTS (SELECT 1 FROM services s WHERE s.id = service_id AND s.owner_user_id = nova_uid()));
CREATE POLICY service_costs_update ON service_costs FOR UPDATE TO nova_app
  USING (nova_scope() = 'user' AND EXISTS (SELECT 1 FROM services s WHERE s.id = service_id AND s.owner_user_id = nova_uid()));
CREATE POLICY service_costs_delete ON service_costs FOR DELETE TO nova_app
  USING (nova_scope() = 'user' AND EXISTS (SELECT 1 FROM services s WHERE s.id = service_id AND s.owner_user_id = nova_uid()));

ALTER TABLE cost_adapter_runs ENABLE ROW LEVEL SECURITY;
