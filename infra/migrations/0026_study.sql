-- 0026: terminy (kolokwium, egzamin, oddanie projektu/zlecenia) i fiszki do nauki (metoda Leitnera).
-- Wszystko prywatne — widzi i zmienia tylko właściciel.
CREATE TABLE deadlines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  subject       text NOT NULL DEFAULT '' CHECK (length(subject) <= 200),
  kind          text NOT NULL DEFAULT 'inne' CHECK (kind IN ('egzamin', 'oddanie', 'inne')),
  due_at        timestamptz NOT NULL,
  -- Bez godziny (cały dzień): due_at to północ czasu polskiego.
  all_day       boolean NOT NULL DEFAULT false,
  done_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deadlines_owner_idx ON deadlines (owner_user_id, due_at);

CREATE TABLE flashcard_decks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  subject       text NOT NULL DEFAULT '' CHECK (length(subject) <= 200),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE flashcards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deck_id       uuid NOT NULL REFERENCES flashcard_decks(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  front         text NOT NULL CHECK (length(front) BETWEEN 1 AND 1000),
  back          text NOT NULL CHECK (length(back) BETWEEN 1 AND 2000),
  -- Pudełko Leitnera 1–5: dobra odpowiedź → wyższe (dłuższa przerwa), zła → 1.
  box           int NOT NULL DEFAULT 1 CHECK (box BETWEEN 1 AND 5),
  due_on        date NOT NULL DEFAULT current_date,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX flashcards_deck_idx ON flashcards (deck_id, due_on);
CREATE INDEX flashcards_owner_due_idx ON flashcards (owner_user_id, due_on);

ALTER TABLE deadlines ENABLE ROW LEVEL SECURITY;
ALTER TABLE flashcard_decks ENABLE ROW LEVEL SECURITY;
ALTER TABLE flashcards ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON deadlines, flashcard_decks, flashcards TO nova_app;
GRANT UPDATE (title, subject, kind, due_at, all_day, done_at) ON deadlines TO nova_app;
GRANT UPDATE (title, subject) ON flashcard_decks TO nova_app;
GRANT UPDATE (front, back, box, due_on) ON flashcards TO nova_app;

CREATE POLICY deadlines_own ON deadlines TO nova_app
  USING (owner_user_id = nova_uid())
  WITH CHECK (owner_user_id = nova_uid() AND nova_is_member(household_id));
CREATE POLICY flashcard_decks_own ON flashcard_decks TO nova_app
  USING (owner_user_id = nova_uid())
  WITH CHECK (owner_user_id = nova_uid() AND nova_is_member(household_id));
CREATE POLICY flashcards_own ON flashcards TO nova_app
  USING (owner_user_id = nova_uid())
  WITH CHECK (owner_user_id = nova_uid() AND EXISTS (
    SELECT 1 FROM flashcard_decks d WHERE d.id = deck_id AND d.owner_user_id = nova_uid()));
