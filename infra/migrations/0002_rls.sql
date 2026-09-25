-- 0002: Row Level Security — druga warstwa izolacji (pierwsza: packages/permissions w API).
-- Rola nova_app działa zawsze w transakcji z ustawionymi:
--   nova.user_id = identyfikator z serwerowej sesji
--   nova.scope   = 'user'   (własne prywatne + jawnie wspólne)
--                | 'shared' (kontekst NovaAI: wyłącznie jawnie wspólne)
-- Brak ustawień => brak danych (domyślna odmowa).

CREATE FUNCTION nova_uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('nova.user_id', true), '')::uuid
$$;

CREATE FUNCTION nova_scope() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('nova.scope', true), ''), 'none')
$$;

CREATE FUNCTION nova_is_member(hh uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.household_id = hh AND m.user_id = nova_uid() AND m.status = 'active'
  )
$$;

CREATE FUNCTION nova_shares_household(other uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM memberships a JOIN memberships b ON a.household_id = b.household_id
    WHERE a.user_id = nova_uid() AND a.status = 'active'
      AND b.user_id = other AND b.status = 'active'
  )
$$;

-- Widoczność rekordu osobistego w bieżącym kontekście.
CREATE FUNCTION nova_can_see(owner uuid, hh uuid, vis text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT (nova_scope() = 'user' AND owner = nova_uid())
      OR (nova_scope() IN ('user', 'shared') AND vis = 'shared' AND nova_is_member(hh))
$$;

CREATE FUNCTION nova_memory_has_active_grant(mid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM memory_grants g WHERE g.memory_id = mid AND g.revoked_at IS NULL)
$$;

GRANT USAGE ON SCHEMA public TO nova_app;
GRANT EXECUTE ON FUNCTION nova_uid(), nova_scope(), nova_is_member(uuid), nova_shares_household(uuid),
  nova_can_see(uuid, uuid, text), nova_memory_has_active_grant(uuid) TO nova_app;

-- users / households / memberships: tylko odczyt w obrębie wspólnego domu.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
GRANT SELECT (id, email, display_name, created_at) ON users TO nova_app;
CREATE POLICY users_select ON users FOR SELECT TO nova_app
  USING (id = nova_uid() OR nova_shares_household(id));

ALTER TABLE households ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON households TO nova_app;
CREATE POLICY households_select ON households FOR SELECT TO nova_app USING (nova_is_member(id));

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON memberships TO nova_app;
CREATE POLICY memberships_select ON memberships FOR SELECT TO nova_app USING (nova_is_member(household_id));

-- agents: prywatny tylko dla właściciela w scope 'user'; agent domu dla aktywnych członków.
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON agents TO nova_app;
CREATE POLICY agents_select ON agents FOR SELECT TO nova_app USING (
  (kind = 'private' AND nova_scope() = 'user' AND owner_user_id = nova_uid())
  OR (kind = 'household' AND nova_scope() IN ('user', 'shared') AND nova_is_member(household_id))
);

-- conversations
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON conversations TO nova_app;
CREATE POLICY conversations_select ON conversations FOR SELECT TO nova_app
  USING (nova_can_see(owner_user_id, household_id, visibility));
CREATE POLICY conversations_insert ON conversations FOR INSERT TO nova_app
  WITH CHECK (owner_user_id = nova_uid() AND nova_is_member(household_id));
CREATE POLICY conversations_update ON conversations FOR UPDATE TO nova_app
  USING (nova_can_see(owner_user_id, household_id, visibility))
  WITH CHECK (nova_can_see(owner_user_id, household_id, visibility));

-- messages: widoczne dokładnie wtedy, gdy widoczna jest rozmowa (RLS działa w podzapytaniu).
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON messages TO nova_app;
CREATE POLICY messages_select ON messages FOR SELECT TO nova_app
  USING (EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_id));
CREATE POLICY messages_insert ON messages FOR INSERT TO nova_app
  WITH CHECK (
    EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_id)
    AND (author_user_id IS NULL OR author_user_id = nova_uid())
  );

-- memories: prywatne tylko właściciel (scope 'user'); wspólne = visibility shared + aktywny grant + członkostwo.
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON memories TO nova_app;
CREATE POLICY memories_select ON memories FOR SELECT TO nova_app USING (
  (nova_scope() = 'user' AND owner_user_id = nova_uid())
  OR (nova_scope() IN ('user', 'shared') AND visibility = 'shared'
      AND nova_is_member(household_id) AND nova_memory_has_active_grant(id))
);
CREATE POLICY memories_insert ON memories FOR INSERT TO nova_app
  WITH CHECK (owner_user_id = nova_uid() AND nova_is_member(household_id));
CREATE POLICY memories_update ON memories FOR UPDATE TO nova_app
  USING (nova_scope() = 'user' AND owner_user_id = nova_uid())
  WITH CHECK (owner_user_id = nova_uid());
CREATE POLICY memories_delete ON memories FOR DELETE TO nova_app
  USING (nova_scope() = 'user' AND owner_user_id = nova_uid());

ALTER TABLE memory_grants ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON memory_grants TO nova_app;
CREATE POLICY memory_grants_select ON memory_grants FOR SELECT TO nova_app USING (
  granted_by = nova_uid() OR (revoked_at IS NULL AND nova_is_member(household_id))
);
CREATE POLICY memory_grants_insert ON memory_grants FOR INSERT TO nova_app WITH CHECK (
  granted_by = nova_uid() AND nova_scope() = 'user'
  AND EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_id AND m.owner_user_id = nova_uid())
);
CREATE POLICY memory_grants_update ON memory_grants FOR UPDATE TO nova_app
  USING (granted_by = nova_uid() AND nova_scope() = 'user')
  WITH CHECK (granted_by = nova_uid());

-- tasks / steps / approvals / tool_calls
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON tasks TO nova_app;
CREATE POLICY tasks_select ON tasks FOR SELECT TO nova_app
  USING (nova_can_see(owner_user_id, household_id, visibility));
CREATE POLICY tasks_insert ON tasks FOR INSERT TO nova_app
  WITH CHECK (owner_user_id = nova_uid() AND nova_is_member(household_id));
CREATE POLICY tasks_update ON tasks FOR UPDATE TO nova_app
  USING (owner_user_id = nova_uid() AND nova_scope() = 'user')
  WITH CHECK (owner_user_id = nova_uid());

ALTER TABLE task_steps ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON task_steps TO nova_app;
CREATE POLICY task_steps_select ON task_steps FOR SELECT TO nova_app
  USING (EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_id));
CREATE POLICY task_steps_insert ON task_steps FOR INSERT TO nova_app
  WITH CHECK (EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_id AND t.owner_user_id = nova_uid()));

ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON approvals TO nova_app;
CREATE POLICY approvals_select ON approvals FOR SELECT TO nova_app
  USING (nova_scope() = 'user' AND owner_user_id = nova_uid());

ALTER TABLE tool_calls ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON tool_calls TO nova_app;
CREATE POLICY tool_calls_select ON tool_calls FOR SELECT TO nova_app
  USING (nova_scope() = 'user' AND owner_user_id = nova_uid());

-- events: te same reguły widoczności co zasób źródłowy.
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON events TO nova_app;
GRANT USAGE ON SEQUENCE events_id_seq TO nova_app;
CREATE POLICY events_select ON events FOR SELECT TO nova_app
  USING (nova_can_see(owner_user_id, household_id, visibility));
CREATE POLICY events_insert ON events FOR INSERT TO nova_app
  WITH CHECK (owner_user_id = nova_uid() AND nova_is_member(household_id));

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE (read_at) ON notifications TO nova_app;
CREATE POLICY notifications_select ON notifications FOR SELECT TO nova_app
  USING (user_id = nova_uid() AND nova_scope() = 'user');
CREATE POLICY notifications_update ON notifications FOR UPDATE TO nova_app
  USING (user_id = nova_uid() AND nova_scope() = 'user');

-- audit_log: zapis wyłącznie przez rolę systemową; użytkownik czyta wpisy, w których jest aktorem lub właścicielem.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON audit_log TO nova_app;
CREATE POLICY audit_log_select ON audit_log FOR SELECT TO nova_app
  USING (nova_scope() = 'user' AND (owner_user_id = nova_uid() OR actor_user_id = nova_uid()));

-- auth_sessions: brak dostępu dla nova_app (obsługa wyłącznie przez rolę systemową).
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
