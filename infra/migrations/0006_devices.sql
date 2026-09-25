-- 0006: urządzenia (Windows Worker), parowanie, granty zdolności/katalogów, dziennik poleceń.

CREATE TABLE devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  name          text NOT NULL,
  platform      text NOT NULL,
  -- Klucz publiczny Ed25519 wygenerowany NA urządzeniu (prywatny nigdy go nie opuszcza).
  public_key    bytea NOT NULL CHECK (length(public_key) = 32),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  paired_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX devices_owner_idx ON devices (owner_user_id);

-- Krótko żyjący kod parowania (przechowywany jako skrót).
CREATE TABLE device_pairing_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  code_hash     bytea NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  device_id     uuid REFERENCES devices(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE device_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  capability    text NOT NULL CHECK (capability IN ('device.files.read', 'device.files.write', 'device.git.read')),
  root          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  expires_at    timestamptz
);
CREATE INDEX device_grants_device_idx ON device_grants (device_id) WHERE revoked_at IS NULL;

CREATE TABLE device_commands (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id       uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  owner_user_id   uuid NOT NULL REFERENCES users(id),
  task_id         uuid REFERENCES tasks(id) ON DELETE SET NULL,
  capability      text NOT NULL,
  params_hash     text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status          text NOT NULL CHECK (status IN ('sent', 'ok', 'error', 'denied', 'expired')),
  result_summary  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

-- Urządzenia i granty są prywatne dla właściciela (także w kontekście agenta NovaAI — brak dostępu).
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
GRANT SELECT (id, household_id, owner_user_id, name, platform, status, paired_at, last_seen_at, revoked_at)
  ON devices TO nova_app;
CREATE POLICY devices_select ON devices FOR SELECT TO nova_app
  USING (nova_scope() = 'user' AND owner_user_id = nova_uid());

ALTER TABLE device_grants ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON device_grants TO nova_app;
CREATE POLICY device_grants_select ON device_grants FOR SELECT TO nova_app
  USING (nova_scope() = 'user' AND owner_user_id = nova_uid());

ALTER TABLE device_commands ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON device_commands TO nova_app;
CREATE POLICY device_commands_select ON device_commands FOR SELECT TO nova_app
  USING (nova_scope() = 'user' AND owner_user_id = nova_uid());

ALTER TABLE device_pairing_codes ENABLE ROW LEVEL SECURITY;
