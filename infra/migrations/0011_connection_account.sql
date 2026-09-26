-- 0011: etykieta połączonego konta i zdolności wybrane przez użytkownika.
--
-- account_label — np. adres z tokenu ID Microsoft; pokazywany w Ustawieniach, aby było widać, które konto
-- podłączono. Tylko do wyświetlania; nie służy do autoryzacji.
--
-- capabilities — zdolności, na które użytkownik się zgodził przy łączeniu (np. tylko „zajętość kalendarza”).
-- Jedno uprawnienie dostawcy może obejmować kilka zdolności (Microsoft Calendars.ReadBasic pozwala na zajętość
-- i na odczyt tytułów wydarzeń), więc aplikacja dodatkowo ogranicza się do wyboru użytkownika.
-- NULL = połączenie sprzed tej migracji (decydują wyłącznie przyznane zakresy).
ALTER TABLE connections ADD COLUMN account_label text CHECK (length(account_label) <= 200);
ALTER TABLE connections ADD COLUMN capabilities text[];
GRANT SELECT (account_label, capabilities) ON connections TO nova_app;

ALTER TABLE oauth_states ADD COLUMN capabilities text[];
