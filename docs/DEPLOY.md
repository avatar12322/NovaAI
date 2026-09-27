# Wdrożenie na VPS — lista zebranych rzeczy

Zbierane punkt po punkcie przed pierwszym wdrożeniem. **Bez sekretów** — klucze i hasła są wyłącznie w `.env`
na serwerze właściciela.

## 1. Domena i serwer — gotowe (2026-09-27)

- Domena `novaai.pl` (OVH); aplikacja pod `https://novaai.pl`, `www.novaai.pl` → przekierowanie.
  DNS: `A novaai.pl → 57.128.208.117`, `A www.novaai.pl → 57.128.208.117`; bez AAAA (IPv6 serwera
  `2001:41d0:601:1100::1c25` działa w systemie — AAAA dopiero po sprawdzeniu połączenia przez IPv6).
- VPS OVH VPS-1 (2 vCPU, 4 GB RAM, 40 GB), Warszawa, Ubuntu 24.04 LTS, automatyczna kopia OVH „Standard”.
  Logowanie: `ssh ubuntu@novaai.pl` kluczem ED25519 (bez hasła). Odnowienie VPS: ręczne — pilnować terminu.
- Przy wdrożeniu: `NOVA_WEB_ORIGIN=https://novaai.pl`, `NOVA_RP_ID=novaai.pl` (klucze dostępu przypisane do
  domeny), `NOVA_TRUST_PROXY=1`; Caddy z certyfikatem Let's Encrypt; zapora: 22, 80, 443.

## 2. Budżet — gotowe (2026-09-27)

- Modele (Anthropic): ostrzeżenie 40 zł, twardy limit 50 zł miesięcznie — ustawiane w aplikacji
  (Ustawienia → Koszt modeli), osobno na serwerze po wdrożeniu (inna baza niż lokalna).
- ElevenLabs: plan Creator (121 000 kredytów miesięcznie, wspólna pula dla wszystkich usług ElevenLabs).
  Wg cennika ElevenLabs: Flash v2.5 ok. 0,5 kredytu za znak (w API 0,5–1), rozpoznawanie mowy 330 kredytów
  za minutę. W `.env`: `ELEVENLABS_MONTHLY_CHARS=100000` (≤ 100 000 kredytów nawet przy 1 kredycie za znak),
  `ELEVENLABS_STT_MONTHLY_MINUTES=60` (≈ 19 800 kredytów). Razem w najgorszym razie ok. 120 000 kredytów.

## 3. Google (Gmail, Kalendarz) — gotowe lokalnie (2026-09-27)

- Projekt Google Cloud `NovaAI`: włączone Gmail API i Google Calendar API; ekran zgody External, domena
  autoryzowana `novaai.pl`; zakresy `gmail.readonly`, `gmail.send`, `calendar.freebusy`; użytkownicy testowi.
- Klient OAuth „Web application”, redirect URI: `https://novaai.pl/api/connections/google/callback` i
  `http://localhost:5173/api/connections/google/callback`. `GOOGLE_CLIENT_ID/SECRET` — w `.env` właściciela.
- Sprawdzone przez właściciela lokalnie: połączenie konta, odczyt poczty, wysyłka e-maila po zatwierdzeniu
  (uprawnienie dołożone przez „Zmień uprawnienia”). Niesprawdzone: zajętość w kalendarzu.
- **Przed wdrożeniem:** Audience → „Publish app” (w trybie Testing Google unieważnia połączenie po 7 dniach);
  użytek osobisty (< 100 osób) bez weryfikacji — z ekranem „aplikacja niezweryfikowana”. Na serwerze te same
  `GOOGLE_CLIENT_ID/SECRET`.

## 4. Plan zajęć — import pliku .ics (2026-09-27)

- WSEI Kraków, Wirtualny Dziekanat IDEIS: Plany toków → tok → zakres dat → Szukaj → „Zapisz jako ical” →
  Ustawienia → Kalendarz → „Plan zajęć i kalendarze z pliku”. Link do planu nie działa jako subskrypcja (zakres
  dat zależy od sesji przeglądarki). **Po wdrożeniu:** wgrać plan ponownie na serwerze (osobna baza).

## 5. Wdrożenie na serwer — krok po kroku

Zestaw w `infra/deploy/`: `setup-server.sh` (pierwsza instalacja, idempotentna), `update.sh` (aktualizacja),
`admin.sh` (konta), `backup.sh` (kopia bazy), `Caddyfile`, usługi systemd, `env.production` (szablon `.env`
bez sekretów). Serwer: Node 22 (NodeSource), pnpm 10.33, PostgreSQL 16 (Ubuntu), Caddy (oficjalne
repozytorium) z certyfikatem Let's Encrypt, zapora ufw (22, 80, 443), użytkownik systemowy `novaai`,
aplikacja w `/opt/novaai/app`, API tylko na `127.0.0.1:4000`. Decyzje: D-038.

**Przed:** Google Cloud → Audience → „Publish app” (pkt 3).

1. Na komputerze, w katalogu repozytorium (gałąź `claude/novaai-jarvis-ui`, po `git pull`):
   `scp infra/deploy/setup-server.sh ubuntu@novaai.pl:`
2. Na serwerze (`ssh ubuntu@novaai.pl`): `sudo bash setup-server.sh`. Pierwsze uruchomienie zatrzyma się na
   kluczu wdrożeniowym — wypisze klucz **publiczny**; dodaj go w GitHub → repozytorium → Settings → Deploy keys
   → Add deploy key (bez „Allow write access”) i uruchom `sudo bash setup-server.sh` ponownie. Skrypt pobiera
   kod, tworzy bazę i `.env` (losowe hasła i klucz szyfrowania — nigdzie nie wypisywane), buduje, migruje,
   uruchamia i sprawdza aplikację.
3. Klucze usług — skopiuj wartości z lokalnego `.env`: `sudo nano /opt/novaai/app/.env` →
   `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (zapis: Ctrl+O, Enter,
   Ctrl+X), potem `sudo systemctl restart novaai`. **Zapisz linię `NOVA_SECRET_KEY=` w menedżerze haseł** — bez
   niej kopia bazy nie odtworzy połączonych kont ani kluczy dodanych w aplikacji.
4. Twoje konto (właściciel domu) i klucz dostępu:
   `sudo bash /opt/novaai/app/infra/deploy/admin.sh create-household "Nasz dom" "twoj@email:Imię"`
   `sudo bash /opt/novaai/app/infra/deploy/admin.sh enroll twoj@email` → otwórz wypisany link (ważny 15 min)
   na telefonie lub komputerze → „Utwórz klucz dostępu”.
5. W aplikacji na `https://novaai.pl` (osobna baza — nic nie przechodzi z komputera):
   Modele AI (model Anthropic z cenami i ceną wyszukiwania 10 USD / 1000) → Koszt modeli (40 / 50 zł) →
   Integracje → Google (połącz, uprawnienia) → Kalendarz → wgraj plan .ics i wybierz przedmioty →
   Ustawienia → Domownicy (zaproszenia dla pozostałych osób).
6. Sprawdzenie: `https://novaai.pl` z kłódką; `http://novaai.pl` i `https://www.novaai.pl` przekierowują na
   `https://novaai.pl`.

**Aktualizacja** (po nowych zmianach w gałęzi): `sudo bash /opt/novaai/app/infra/deploy/update.sh` — pobiera
kod, instaluje zależności, buduje, robi kopię bazy przed migracją, migruje, restartuje i sprawdza zdrowie.

**Diagnostyka:** `systemctl status novaai caddy`, `journalctl -u novaai -n 100 --no-pager`,
`curl -s http://127.0.0.1:4000/api/health`.

### Kopie zapasowe

- Codziennie o 3:30 (`novaai-backup.timer`): `pg_dump` do `/var/backups/novaai`, 14 dni; ręcznie:
  `sudo novaai-backup`. Do tego automatyczna kopia VPS w OVH. Kopie na serwerze nie chronią przed jego utratą —
  co jakiś czas pobierz najnowszą: na serwerze `sudo cp /var/backups/novaai/<plik>.dump ~ && sudo chown ubuntu
~/<plik>.dump`, na komputerze `scp ubuntu@novaai.pl:<plik>.dump .`, potem usuń kopię z katalogu domowego.
- Odtworzenie: `sudo systemctl stop novaai`, `sudo cat /var/backups/novaai/<plik>.dump | sudo -u postgres
pg_restore --clean --if-exists -d novaai`, `sudo systemctl start novaai` (ten sam `NOVA_SECRET_KEY` w `.env`).

## Dalej (opcjonalnie)

- [x] Wyszukiwanie w internecie: Anthropic (ten sam klucz) — cena w cenniku modelu (D-036)
- [x] Rejestracja: tylko z zaproszenia, logowanie kluczem dostępu (D-037)
- [-] Pominięte (decyzja właściciela): Slack, Outlook uczelniany, Home Assistant
- [ ] Rekord AAAA (IPv6) — po sprawdzeniu, że serwer odpowiada przez IPv6
- [ ] Worker na Windows, słowo wybudzające
- [ ] Spotify
