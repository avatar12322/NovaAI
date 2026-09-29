-- 0021: powiadomienia push (Web Push, np. iPhone z aplikacją na ekranie głównym).
-- Subskrypcje urządzeń (adres usługi push + klucze szyfrowania od przeglądarki) i klucz VAPID serwera
-- (prywatny zaszyfrowany NOVA_SECRET_KEY). Tylko rola systemowa — rola aplikacji nie ma dostępu.
CREATE TABLE push_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  endpoint     text NOT NULL UNIQUE CHECK (endpoint ~ '^https?://' AND length(endpoint) <= 1000),
  p256dh       text NOT NULL CHECK (length(p256dh) <= 200),
  auth         text NOT NULL CHECK (length(auth) <= 100),
  label        text NOT NULL DEFAULT '' CHECK (length(label) <= 120),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_ok_at   timestamptz,
  failures     int NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE TABLE push_vapid (
  id                 int PRIMARY KEY CHECK (id = 1),
  public_key         text NOT NULL,
  private_ciphertext bytea NOT NULL,
  key_id             text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE push_vapid ENABLE ROW LEVEL SECURITY;

-- Każde powiadomienie w aplikacji jest raz przekazywane do push (wysłane albo pominięte — brak urządzeń).
ALTER TABLE notifications ADD COLUMN push_handled_at timestamptz;
UPDATE notifications SET push_handled_at = created_at;
CREATE INDEX notifications_push_pending_idx ON notifications (created_at) WHERE push_handled_at IS NULL;
