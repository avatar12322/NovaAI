-- 0007: integracje (connectory), OAuth (state + PKCE), granty free/busy dla NovaAI, webhooki, kalendarz lokalny.

CREATE TABLE connections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id      uuid NOT NULL REFERENCES households(id),
  owner_user_id     uuid NOT NULL REFERENCES users(id),
  provider          text NOT NULL CHECK (provider IN ('google', 'microsoft', 'slack')),
  status            text NOT NULL CHECK (status IN ('connected', 'revoked', 'error')),
  scopes            text[] NOT NULL DEFAULT '{}',
  -- Tokeny wyłącznie zaszyfrowane (AES-256-GCM, AAD = użytkownik|dostawca|id). Brak dostępu dla nova_app.
  token_ciphertext  bytea,
  key_id            text,
  access_expires_at timestamptz,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz
);
CREATE UNIQUE INDEX connections_active_uq ON connections (owner_user_id, provider) WHERE status <> 'revoked';

CREATE TABLE oauth_states (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL REFERENCES users(id),
  household_id    uuid NOT NULL REFERENCES households(id),
  provider        text NOT NULL,
  state_hash      bytea NOT NULL UNIQUE,
  verifier_cipher bytea NOT NULL,
  key_id          text NOT NULL,
  scopes          text[] NOT NULL,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Jawne udostępnienie NovaAI informacji free/busy (bez szczegółów wydarzeń) z kalendarza właściciela.
CREATE TABLE calendar_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  capability    text NOT NULL CHECK (capability IN ('calendar.freebusy')),
  grantee       text NOT NULL CHECK (grantee IN ('household_agent')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  expires_at    timestamptz
);
CREATE UNIQUE INDEX calendar_grants_active_uq ON calendar_grants (owner_user_id, capability, grantee) WHERE revoked_at IS NULL;

-- Kalendarz lokalny (adapter bez OAuth): prywatne wydarzenia właściciela.
CREATE TABLE local_calendar_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  title         text NOT NULL,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL CHECK (ends_at > starts_at),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX local_calendar_events_owner_idx ON local_calendar_events (owner_user_id, starts_at);

-- Deduplikacja dostaw webhooków (ponowienia dostawców).
CREATE TABLE webhook_deliveries (
  id          bigserial PRIMARY KEY,
  provider    text NOT NULL,
  delivery_id text NOT NULL,
  event_type  text,
  status      text NOT NULL CHECK (status IN ('accepted', 'ignored')),
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, delivery_id)
);

ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
GRANT SELECT (id, household_id, owner_user_id, provider, status, scopes, access_expires_at, last_error, created_at, updated_at, revoked_at)
  ON connections TO nova_app;
CREATE POLICY connections_select ON connections FOR SELECT TO nova_app
  USING (nova_scope() = 'user' AND owner_user_id = nova_uid());

ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;

ALTER TABLE calendar_grants ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON calendar_grants TO nova_app;
CREATE POLICY calendar_grants_select ON calendar_grants FOR SELECT TO nova_app
  USING (nova_scope() = 'user' AND owner_user_id = nova_uid());

ALTER TABLE local_calendar_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON local_calendar_events TO nova_app;
CREATE POLICY local_calendar_events_select ON local_calendar_events FOR SELECT TO nova_app
  USING (nova_scope() = 'user' AND owner_user_id = nova_uid());
CREATE POLICY local_calendar_events_insert ON local_calendar_events FOR INSERT TO nova_app
  WITH CHECK (owner_user_id = nova_uid() AND nova_is_member(household_id));
CREATE POLICY local_calendar_events_delete ON local_calendar_events FOR DELETE TO nova_app
  USING (nova_scope() = 'user' AND owner_user_id = nova_uid());
