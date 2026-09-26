-- 0017: zużycie rozpoznawania mowy (ElevenLabs) — sekundy nagrań do miesięcznego limitu domu. Bez treści.
CREATE TABLE stt_usage (
  id           bigserial PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  seconds      numeric(8, 2) NOT NULL CHECK (seconds >= 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stt_usage_household_idx ON stt_usage (household_id, created_at);
-- Tylko rola systemowa (serwer): rola aplikacji nie ma uprawnień do tej tabeli.
ALTER TABLE stt_usage ENABLE ROW LEVEL SECURITY;
