-- 0027: Skrót Siri „Zapytaj Novę” — osobisty klucz do jednego endpointu (POST /api/shortcut/ask).
-- Klucz widoczny raz, w bazie tylko skrót SHA-256; jeden na osobę (nowy zastępuje poprzedni, usunięcie
-- unieważnia). Pytania trafiają do prywatnej rozmowy „Siri” tej osoby. Tylko rola systemowa.
CREATE TABLE shortcut_keys (
  user_id         uuid PRIMARY KEY REFERENCES users(id),
  household_id    uuid NOT NULL REFERENCES households(id),
  key_hash        bytea NOT NULL UNIQUE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz
);
ALTER TABLE shortcut_keys ENABLE ROW LEVEL SECURITY;
