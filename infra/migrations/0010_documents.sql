-- 0010: pamięć dokumentów (knowledge) — pliki PDF/TXT/Markdown, fragmenty z lokalizacją (strona / linie /
-- nagłówek) i wyszukiwanie pełnotekstowe. Widoczność jak w pozostałych danych: prywatny dokument widzi tylko
-- właściciel (scope 'user'), wspólny — aktywni członkowie domu i NovaAI (scope 'shared').

CREATE TABLE documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES households(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  visibility    text NOT NULL CHECK (visibility IN ('private', 'shared')),
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  filename      text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  format        text NOT NULL CHECK (format IN ('pdf', 'txt', 'md')),
  size_bytes    integer NOT NULL CHECK (size_bytes > 0),
  sha256        text NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'indexing', 'ready', 'failed')),
  error         text,
  page_count    integer,
  chunk_count   integer NOT NULL DEFAULT 0,
  char_count    integer NOT NULL DEFAULT 0,
  -- Rośnie przy każdym (ponownym) indeksowaniu; zadanie ze starszą wersją nie nadpisze nowszego wyniku.
  index_version integer NOT NULL DEFAULT 1,
  task_id       uuid REFERENCES tasks(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  indexed_at    timestamptz
);
CREATE INDEX documents_owner_idx ON documents (owner_user_id, created_at DESC);
CREATE INDEX documents_household_idx ON documents (household_id, visibility, created_at DESC);
CREATE UNIQUE INDEX documents_owner_sha_idx ON documents (owner_user_id, sha256);

-- Oryginał pliku (do ponownego indeksowania i pobrania). Osobna tabela: listy nie czytają bajtów.
CREATE TABLE document_blobs (
  document_id uuid PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  content     bytea NOT NULL
);

-- Fragmenty. Właściciel/dom/widoczność są skopiowane z dokumentu (zmieniane w tej samej transakcji),
-- aby RLS i filtr zakresu działały bez złączeń podczas wyszukiwania.
CREATE TABLE document_chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  household_id  uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  visibility    text NOT NULL CHECK (visibility IN ('private', 'shared')),
  ord           integer NOT NULL,
  page          integer,
  line_start    integer,
  line_end      integer,
  heading       text,
  content       text NOT NULL,
  -- Tekst znormalizowany w aplikacji (małe litery, bez znaków diakrytycznych) — ten sam proces dla zapytań.
  search_text   text NOT NULL,
  tsv           tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
  UNIQUE (document_id, ord)
);
CREATE INDEX document_chunks_tsv_idx ON document_chunks USING gin (tsv);
CREATE INDEX document_chunks_scope_idx ON document_chunks (household_id, visibility);
CREATE INDEX document_chunks_owner_idx ON document_chunks (owner_user_id);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON documents TO nova_app;
CREATE POLICY documents_select ON documents FOR SELECT TO nova_app
  USING (nova_can_see(owner_user_id, household_id, visibility));
CREATE POLICY documents_insert ON documents FOR INSERT TO nova_app
  WITH CHECK (owner_user_id = nova_uid() AND nova_scope() = 'user' AND nova_is_member(household_id));
CREATE POLICY documents_update ON documents FOR UPDATE TO nova_app
  USING (owner_user_id = nova_uid() AND nova_scope() = 'user')
  WITH CHECK (owner_user_id = nova_uid());
CREATE POLICY documents_delete ON documents FOR DELETE TO nova_app
  USING (owner_user_id = nova_uid() AND nova_scope() = 'user');

-- Oryginał: widoczny tylko razem z dokumentem (podzapytanie podlega RLS tabeli documents).
ALTER TABLE document_blobs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON document_blobs TO nova_app;
CREATE POLICY document_blobs_select ON document_blobs FOR SELECT TO nova_app
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id));
CREATE POLICY document_blobs_insert ON document_blobs FOR INSERT TO nova_app
  WITH CHECK (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND d.owner_user_id = nova_uid()));

-- Fragmenty zapisuje proces indeksowania (rola systemowa); aplikacja czyta i zmienia widoczność.
ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE (visibility) ON document_chunks TO nova_app;
CREATE POLICY document_chunks_select ON document_chunks FOR SELECT TO nova_app
  USING (nova_can_see(owner_user_id, household_id, visibility));
CREATE POLICY document_chunks_update ON document_chunks FOR UPDATE TO nova_app
  USING (owner_user_id = nova_uid() AND nova_scope() = 'user')
  WITH CHECK (owner_user_id = nova_uid());
