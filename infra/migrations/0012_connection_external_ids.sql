-- 0012: identyfikatory konta u dostawcy (np. workspace i użytkownik Slack) — do przypisania zdarzeń dostawcy
-- (odwołanie tokenów, odinstalowanie aplikacji) do właściwej osoby w NovaAI.
ALTER TABLE connections ADD COLUMN external_team_id text CHECK (length(external_team_id) <= 64);
ALTER TABLE connections ADD COLUMN external_user_id text CHECK (length(external_user_id) <= 64);
GRANT SELECT (external_team_id, external_user_id) ON connections TO nova_app;

-- Jedno konto u dostawcy może być aktywnie połączone tylko z jedną osobą NovaAI (izolacja: zdarzenie
-- „token odwołany” dla tego konta nie może dotyczyć dwóch osób, a nikt nie podłączy cudzego konta obok właściciela).
CREATE UNIQUE INDEX connections_external_owner_uq
  ON connections (provider, external_team_id, external_user_id)
  WHERE status <> 'revoked' AND external_user_id IS NOT NULL;

-- Ponowienia dostaw webhooków (ten sam event_id): licznik zamiast ponownego przetworzenia.
ALTER TABLE webhook_deliveries ADD COLUMN duplicates integer NOT NULL DEFAULT 0;
