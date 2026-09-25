-- 0001: rdzeń danych — tożsamość, dom, agenci, rozmowy, pamięć, zadania, zgody, zdarzenia, audyt.
-- Zasada: każdy rekord osobisty ma owner_user_id + household_id (+ visibility, gdzie ma sens).
-- Dostęp do 'shared' wymaga jawnego udostępnienia i aktywnego członkostwa (patrz 0002_rls.sql).

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE,
  display_name   text NOT NULL,
  is_dev_fixture boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  disabled_at    timestamptz
);

CREATE TABLE households (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  role         text NOT NULL CHECK (role IN ('owner', 'member')),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  UNIQUE (household_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id) WHERE status = 'active';

-- Sesje serwerowe: przechowujemy wyłącznie skrót SHA-256 tokenu z ciasteczka.
CREATE TABLE auth_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  token_hash   bytea NOT NULL UNIQUE,
  method       text NOT NULL CHECK (method IN ('dev', 'passkey')),
  env          text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  user_agent   text
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);

-- Trzy konteksty agentów: prywatny per użytkownik + jeden wspólny (NovaAI) per dom.
CREATE TABLE agents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id    uuid NOT NULL REFERENCES households(id),
  kind            text NOT NULL CHECK (kind IN ('private', 'household')),
  owner_user_id   uuid REFERENCES users(id),
  name            text NOT NULL,
  runtime_profile text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'private') = (owner_user_id IS NOT NULL))
);
CREATE UNIQUE INDEX agents_private_uq ON agents (household_id, owner_user_id) WHERE kind = 'private';
CREATE UNIQUE INDEX agents_household_uq ON agents (household_id) WHERE kind = 'household';

CREATE TABLE conversations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  agent_id      uuid NOT NULL REFERENCES agents(id),
  visibility    text NOT NULL CHECK (visibility IN ('private', 'shared')),
  title         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);
CREATE INDEX conversations_owner_idx ON conversations (owner_user_id, updated_at DESC, id DESC);
CREATE INDEX conversations_household_idx ON conversations (household_id, visibility, updated_at DESC, id DESC);

-- Spójność: rozmowa prywatna => prywatny agent właściciela; wspólna => agent domu.
CREATE FUNCTION conversations_agent_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE a agents%ROWTYPE;
BEGIN
  SELECT * INTO a FROM agents WHERE id = NEW.agent_id;
  IF a.id IS NULL OR a.household_id <> NEW.household_id THEN
    RAISE EXCEPTION 'conversation agent must belong to the same household';
  END IF;
  IF NEW.visibility = 'private' AND NOT (a.kind = 'private' AND a.owner_user_id = NEW.owner_user_id) THEN
    RAISE EXCEPTION 'private conversation requires the owner''s private agent';
  END IF;
  IF NEW.visibility = 'shared' AND a.kind <> 'household' THEN
    RAISE EXCEPTION 'shared conversation requires the household agent';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER conversations_agent_check BEFORE INSERT OR UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_agent_check();

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author_user_id  uuid REFERENCES users(id),
  role            text NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content         text NOT NULL,
  meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at, id);

-- Pamięć: profile (fakty), episodic (historia), knowledge (dokumenty). Operational = tabele zadań.
CREATE TABLE memories (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id           uuid NOT NULL REFERENCES households(id),
  owner_user_id          uuid NOT NULL REFERENCES users(id),
  kind                   text NOT NULL CHECK (kind IN ('profile', 'episodic', 'knowledge')),
  visibility             text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared')),
  content                text NOT NULL,
  source                 text NOT NULL DEFAULT 'user',
  source_conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memories_owner_idx ON memories (owner_user_id, updated_at DESC, id DESC);
CREATE INDEX memories_household_idx ON memories (household_id, visibility, updated_at DESC, id DESC);

-- Jawne udostępnienie pamięci. Aktywny grant + visibility='shared' są wymagane jednocześnie.
CREATE TABLE memory_grants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id    uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  household_id uuid NOT NULL REFERENCES households(id),
  granted_by   uuid NOT NULL REFERENCES users(id),
  grantee      text NOT NULL DEFAULT 'household' CHECK (grantee IN ('household')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX memory_grants_active_uq ON memory_grants (memory_id) WHERE revoked_at IS NULL;

-- Trwała kolejka zadań (lease + heartbeat + próby).
CREATE TABLE tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id     uuid NOT NULL REFERENCES households(id),
  owner_user_id    uuid NOT NULL REFERENCES users(id),
  visibility       text NOT NULL CHECK (visibility IN ('private', 'shared')),
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  kind             text NOT NULL,
  title            text NOT NULL,
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled')),
  input            jsonb NOT NULL DEFAULT '{}'::jsonb,
  result           jsonb,
  error            text,
  attempts         int NOT NULL DEFAULT 0,
  max_attempts     int NOT NULL DEFAULT 3,
  lease_owner      text,
  lease_expires_at timestamptz,
  heartbeat_at     timestamptz,
  run_after        timestamptz NOT NULL DEFAULT now(),
  request_id       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);
CREATE INDEX tasks_queue_idx ON tasks (run_after, created_at) WHERE status = 'queued';
CREATE INDEX tasks_lease_idx ON tasks (lease_expires_at) WHERE status = 'running';
CREATE INDEX tasks_owner_idx ON tasks (owner_user_id, created_at DESC, id DESC);
CREATE INDEX tasks_household_idx ON tasks (household_id, visibility, created_at DESC, id DESC);

CREATE TABLE task_steps (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id           uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  seq               int NOT NULL,
  key               text NOT NULL,
  title             text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('tool', 'model', 'note')),
  tool              text,
  params            jsonb NOT NULL DEFAULT '{}'::jsonb,
  depends_on        text[] NOT NULL DEFAULT '{}',
  requires_approval boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'skipped')),
  approval_id       uuid,
  output            jsonb,
  error             text,
  attempts          int NOT NULL DEFAULT 0,
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, key),
  UNIQUE (task_id, seq)
);

-- Zgoda na konkretną, zamrożoną akcję. action_hash = SHA-256 kanonicznego JSON {tool, params}.
CREATE TABLE approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  task_id       uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id       uuid NOT NULL REFERENCES task_steps(id) ON DELETE CASCADE,
  tool          text NOT NULL,
  capability    text NOT NULL,
  action        jsonb NOT NULL,
  action_hash   text NOT NULL,
  summary       text NOT NULL,
  target        text NOT NULL,
  scope         text NOT NULL,
  diff          text,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'invalidated', 'executing', 'executed', 'failed')),
  expires_at    timestamptz NOT NULL,
  resolved_by   uuid REFERENCES users(id),
  resolved_at   timestamptz,
  execution_id  uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  executed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX approvals_step_open_uq ON approvals (step_id) WHERE status IN ('pending', 'approved', 'executing');
CREATE INDEX approvals_owner_idx ON approvals (owner_user_id, status, created_at DESC);

CREATE TABLE tool_calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id    uuid NOT NULL REFERENCES households(id),
  owner_user_id   uuid NOT NULL REFERENCES users(id),
  task_id         uuid REFERENCES tasks(id) ON DELETE SET NULL,
  step_id         uuid REFERENCES task_steps(id) ON DELETE SET NULL,
  approval_id     uuid REFERENCES approvals(id) ON DELETE SET NULL,
  tool            text NOT NULL,
  capability      text NOT NULL,
  params_hash     text NOT NULL,
  params_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text UNIQUE,
  status          text NOT NULL CHECK (status IN ('denied', 'running', 'succeeded', 'failed')),
  result_summary  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX tool_calls_owner_idx ON tool_calls (owner_user_id, created_at DESC);

-- Strumień zdarzeń dla Activity Strip. Payload nie zawiera sekretów ani treści prywatnych.
CREATE TABLE events (
  id            bigserial PRIMARY KEY,
  household_id  uuid NOT NULL REFERENCES households(id),
  owner_user_id uuid REFERENCES users(id),
  visibility    text NOT NULL CHECK (visibility IN ('private', 'shared')),
  task_id       uuid REFERENCES tasks(id) ON DELETE CASCADE,
  type          text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_household_idx ON events (household_id, id);
CREATE INDEX events_task_idx ON events (task_id, id);

CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  kind         text NOT NULL,
  title        text NOT NULL,
  body         text NOT NULL DEFAULT '',
  ref_type     text,
  ref_id       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  read_at      timestamptz
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

-- Dziennik audytu: bez sekretów i treści; skrót parametrów zamiast wartości.
CREATE TABLE audit_log (
  id             bigserial PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  actor_kind     text NOT NULL CHECK (actor_kind IN ('user', 'agent', 'system', 'device')),
  actor_user_id  uuid REFERENCES users(id),
  owner_user_id  uuid REFERENCES users(id),
  household_id   uuid REFERENCES households(id),
  source         text NOT NULL,
  action         text NOT NULL,
  resource_type  text,
  resource_id    text,
  tool           text,
  outcome        text NOT NULL CHECK (outcome IN ('allow', 'deny', 'ok', 'error')),
  correlation_id text,
  params_hash    text,
  details        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_owner_idx ON audit_log (owner_user_id, id DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id, id DESC);
