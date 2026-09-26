-- 0016: zużycie syntezy mowy (ElevenLabs) — liczba znaków do miesięcznego limitu domu. Bez treści.
CREATE TABLE tts_usage (
  id           bigserial PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  chars        integer NOT NULL CHECK (chars > 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tts_usage_household_idx ON tts_usage (household_id, created_at);
-- Tylko rola systemowa (serwer): rola aplikacji nie ma uprawnień do tej tabeli.
ALTER TABLE tts_usage ENABLE ROW LEVEL SECURITY;
