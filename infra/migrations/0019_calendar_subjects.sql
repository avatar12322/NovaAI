-- 0019: wybór przedmiotów w wgranym planie — plan toku z dziekanatu zawiera zajęcia wszystkich ścieżek i grup.
-- Odznaczone przedmioty są ukryte: nie trafiają do przeglądu dnia, zajętości ani do asystenta. Wybór zostaje
-- przy nowej wersji planu (nazwy przedmiotów w imporcie).
ALTER TABLE calendar_imports ADD COLUMN excluded_titles text[] NOT NULL DEFAULT '{}';
ALTER TABLE local_calendar_events ADD COLUMN hidden boolean NOT NULL DEFAULT false;
GRANT UPDATE (hidden) ON local_calendar_events TO nova_app;
CREATE POLICY local_calendar_events_update ON local_calendar_events FOR UPDATE TO nova_app
  USING (nova_scope() = 'user' AND owner_user_id = nova_uid())
  WITH CHECK (owner_user_id = nova_uid());
