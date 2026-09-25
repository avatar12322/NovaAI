-- 0009: logowanie passkeys (WebAuthn) i jednorazowe linki rejestracyjne (fallback wdrożeniowy).

CREATE TABLE webauthn_credentials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  credential_id text NOT NULL UNIQUE,            -- base64url z uwierzytelniacza
  public_key    bytea NOT NULL,
  counter       bigint NOT NULL DEFAULT 0,
  transports    text[] NOT NULL DEFAULT '{}',
  device_type   text NOT NULL,
  backed_up     boolean NOT NULL DEFAULT false,
  name          text NOT NULL DEFAULT 'Klucz dostępu',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);
CREATE INDEX webauthn_credentials_user_idx ON webauthn_credentials (user_id);

-- Wyzwania są jednorazowe i krótko żyjące; dla logowania nie znamy jeszcze użytkownika.
CREATE TABLE webauthn_challenges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid REFERENCES users(id),
  purpose    text NOT NULL CHECK (purpose IN ('register', 'login')),
  challenge  text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

-- Link rejestracyjny generowany lokalnie przez administratora (CLI): jednorazowy, 15 minut, skrót w bazie.
CREATE TABLE enrollment_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE webauthn_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE webauthn_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollment_tokens ENABLE ROW LEVEL SECURITY;
