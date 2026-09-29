-- 0024: zdjęcia w rozmowach (np. paragon, lodówka, pismo) — model je widzi w turze, w której zostały wysłane.
-- Zdjęcie należy do autora; po dołączeniu do wiadomości ma widoczność rozmowy (prywatna / wspólna).
CREATE TABLE chat_images (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id    uuid NOT NULL REFERENCES households(id),
  owner_user_id   uuid NOT NULL REFERENCES users(id),
  conversation_id uuid REFERENCES conversations(id),
  visibility      text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared')),
  mime            text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes           bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 100 AND 4194304),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_images_conversation_idx ON chat_images (conversation_id);
CREATE INDEX chat_images_unattached_idx ON chat_images (created_at) WHERE conversation_id IS NULL;

ALTER TABLE chat_images ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON chat_images TO nova_app;
GRANT UPDATE (conversation_id, visibility) ON chat_images TO nova_app;
CREATE POLICY chat_images_select ON chat_images FOR SELECT TO nova_app
  USING (nova_can_see(owner_user_id, household_id, visibility));
CREATE POLICY chat_images_insert ON chat_images FOR INSERT TO nova_app
  WITH CHECK (owner_user_id = nova_uid() AND nova_is_member(household_id) AND conversation_id IS NULL);
CREATE POLICY chat_images_update ON chat_images FOR UPDATE TO nova_app
  USING (owner_user_id = nova_uid() AND conversation_id IS NULL)
  WITH CHECK (owner_user_id = nova_uid());
