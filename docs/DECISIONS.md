# Decyzje architektoniczne (ADR-lite)

Każdy wpis: kontekst → decyzja → konsekwencje. Odstępstwa od `docs/MASTER_SPEC.md` są oznaczone **[odstępstwo]**.

## D-001 Stan początkowy repozytorium

Repozytorium było puste (brak commitów, brak `AGENTS.md`/`CLAUDE.md`). Szkielet zbudowano od zera według
układu z sekcji 2 specyfikacji. `MASTER_SPEC.md` i `START_CLAUDE.md` skopiowano do `docs/`, aby kolejne
sesje miały je w repo. Praca na gałęzi `claude/master-spec-m0-m3-qgwxry`, bez pushowania (instrukcja użytkownika).

## D-002 Monorepo pnpm, TypeScript 6.0, pakiety źródłowe

- pnpm workspace (`apps/*`, `packages/*`), TypeScript `~6.0.3` (7.x to port natywny; `typescript-eslint`
  wspiera `<6.1`). `moduleResolution: Bundler`.
- Pakiety wewnętrzne eksportują źródła `.ts` (bez kroku budowania). API uruchamiane przez `tsx`
  (dev i start), web budowany przez Vite. Typecheck: `tsc --noEmit` w każdym pakiecie.
- Konsekwencja: produkcyjny start API wymaga `tsx` (devDependency) — do zmiany na bundel `esbuild`
  przed pierwszym wdrożeniem (zadanie w PROGRESS).

## D-003 Backend: Fastify 5 + zod 4 + node-postgres (bez ORM)

Fastify: szybki, dojrzały, wbudowane limity body, hooki i `inject` do testów bez sieci. Walidacja
runtime schematami zod z `packages/contracts` (współdzielone z web). SQL pisany ręcznie — model uprawnień
opiera się na RLS i precyzyjnych zapytaniach, ORM utrudniłby kontrolę nad `set_config` w transakcji.

## D-004 Migracje: czyste pliki SQL + własny runner

`infra/migrations/NNNN_nazwa.sql`, runner w `apps/api/src/db/migrate.ts`: tabela `schema_migrations`
z sumą SHA-256 (zmiana zastosowanej migracji = błąd), każda migracja w transakcji, `pg_advisory_lock`
przeciw równoległym uruchomieniom. Brak narzędzia zewnętrznego — mniej zależności, pełna przewidywalność.

## D-005 Dwie role Postgres i Row Level Security jako druga warstwa izolacji

- `nova_owner`: właściciel schematu; migracje, kolejka, sesje, audyt (bypass RLS jako właściciel tabel).
- `nova_app` (`NOBYPASSRLS`): wszystkie odczyty/zapisy treści w imieniu użytkownika, zawsze w transakcji
  z `set_config('nova.user_id', …, true)` i `nova.scope` = `user` | `shared`.
- Polityki RLS (`0002_rls.sql`) odwzorowują reguły z `packages/permissions`. Warstwa 1 (aplikacja) decyduje
  i audytuje; warstwa 2 (RLS) chroni przed błędem w kodzie (zapomniany `WHERE`). Kontekst NovaAI
  (`scope=shared`) nie widzi prywatnych danych nawet osoby, która z nim rozmawia.
- Ograniczenie: proces API zna oba hasła; RLS chroni przed błędami logiki, nie przed przejęciem procesu.

## D-006 Lokalny Postgres bez Dockera w sesji zdalnej

Środowisko sesji ma klienta Docker bez demona, ale ma PostgreSQL 16. `scripts/pg-local.sh` tworzy klaster
w `./.data/pg` (port 54329, tylko loopback). `infra/compose.yaml` daje ten sam port i role dla Docker
Desktop (Windows). Oba warianty wykonują `infra/db/init.sql` (role + bazy `nova_dev`, `nova_test`).
Hasło superużytkownika kontenera nie jest w repozytorium (zgłoszenie skanera sekretów, 2026-09-26): Compose wymaga
`NOVA_PG_SUPERUSER_PASSWORD` z lokalnego `.env` (`docker compose --env-file .env -f infra/compose.yaml up -d`).
Wcześniejsza wartość była wyłącznie deweloperska (kontener na 127.0.0.1) i pozostaje w historii Gita.

## D-007 Sesje i logowanie

- Sesje serwerowe: losowy token 256-bit w ciasteczku `HttpOnly; SameSite=Strict` (`Secure` w produkcji);
  w bazie tylko SHA-256 tokenu. Sesja jest związana ze środowiskiem (`env`).
- CSRF: każda mutacja pod `/api/` wymaga nagłówka `x-nova-csrf: 1` + kontrola `Origin`.
- Logowanie testowe (2 sztuczne konta `alfa@example.test`, `beta@example.test`, dom „Dom testowy”):
  trasa rejestrowana tylko gdy `NOVA_ENV ∈ {development,test}` i `NOVA_DEV_LOGIN=true`.
  `NOVA_DEV_LOGIN=true` przy `NOVA_ENV=production` zatrzymuje start (test w `health.test.ts`).
  Sesje `dev` i konta fixture są odrzucane w produkcji nawet przy istniejącym ciasteczku.
- Passkeys/WebAuthn — zaimplementowane (patrz D-021). **Fallback wdrożeniowy**: jednorazowy link rejestracji
  klucza generowany lokalnie przez administratora w CLI (`admin enroll <email>`), 15 min, skrót w bazie.

## D-008 Trzy konteksty agentów

Tabela `agents`: prywatny agent per użytkownik + agent domu „NovaAI”. Agenta rozmowy wyznacza serwer przy
tworzeniu (klient podaje tylko `space`), a trigger w bazie wymusza spójność (prywatna rozmowa ⇒ prywatny
agent właściciela; wspólna ⇒ agent domu). `runtime_profile` wskazuje przyszły profil Hermesa.

## D-009 Odpowiedź 404 zamiast 403 dla cudzych zasobów

Brak prawa odczytu ⇒ `404` (bez ujawniania istnienia) + wpis `deny` w `audit_log` z `owner_user_id`,
bez treści. Prawo odczytu bez prawa operacji (np. Beta próbuje cofnąć udostępnienie pamięci Alfy) ⇒ `403`.

## D-010 Frontend: Vite + React 19, własne komponenty i tokeny

Bez biblioteki komponentów. `packages/ui/src/tokens.css`: neutralna paleta + jeden akcent, promień 6–10 px,
motyw jasny/ciemny (systemowy lub wymuszony `data-theme`). Fonty IBM Plex Sans/Mono z pakietów
`@fontsource` (licencja SIL OFL 1.1, serwowane lokalnie — bez zewnętrznego CDN).

## D-011 Trwała kolejka zadań w Postgres (bez Redisa)

- `tasks` + `task_steps`; claim przez `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`,
  dzierżawa `lease_expires_at` odnawiana heartbeatem co `lease/3`. Odzysk (`recover()`): wygasła dzierżawa ⇒
  kroki `running` wracają do `pending`, zadanie do `queued`; po `max_attempts` utraconych dzierżaw ⇒ `failed`.
- Kroki mają zależności (`depends_on`); pętla wykonuje każdy krok, którego zależności są `completed`,
  więc niezależne kroki kończą się, gdy inny czeka na zgodę (`waiting_approval`).
- Ponowienia kroków: wykładniczy backoff, maks. 3 próby; `ToolDenied` nie jest ponawiane.
- Kolejka działa w procesie API (`NOVA_QUEUE_ENABLED`), bezpieczna dla wielu instancji (SKIP LOCKED).
- Tura czatu to zadanie `agent.turn` — przeżywa restart, a UI widzi postęp.

## D-012 Zgody: zamrożona akcja + skrót + idempotencja

- `approvals.action` = dokładne parametry po `prepare()` (np. rozwiązany odbiorca), `action_hash` =
  SHA-256 kanonicznego JSON `{tool, params}`. Klient zatwierdza, odsyłając skrót, który widział.
- Rozstrzygnięcie: pojedynczy warunkowy `UPDATE … WHERE status='pending' AND expires_at > now() AND action_hash=$`
  — wyścig dwóch decyzji wygrywa dokładnie jedna (test).
- Wykonanie: `approved → executing` atomowo z weryfikacją skrótu względem bieżących parametrów kroku;
  rozbieżność ⇒ `invalidated`. Broker ponownie sprawdza zgodę (`executing`), właściciela, zadanie (`running`)
  i uprawnienia tuż przed efektem. Klucz idempotencji = `execution_id` zgody (UNIQUE w `tool_calls`
  i w `notifications`) ⇒ powtórzenie po awarii nie duplikuje efektu.
- Anulowanie zadania unieważnia zgody `pending/approved/executing`.

## D-013 Zdarzenia: NOTIFY z samym ID + ponowny odczyt pod RLS odbiorcy

Trigger `events_notify` wysyła `pg_notify('nova_events', id)`. Serwer SSE dla każdego ID pobiera zdarzenie
w transakcji z kontekstem odbiorcy (RLS), więc prywatne zdarzenia drugiej osoby nie trafiają do strumienia,
a odebranie członkostwa działa od razu. Świeże połączenie zaczyna od końca strumienia; wznowienie po
`Last-Event-ID`. Payloady zawierają ID/statusy/tytuły, nigdy treści wiadomości/pamięci ani sekrety
(dodatkowo `redact()`). Zgody emitują zdarzenia prywatne nawet dla wspólnych zadań.

## D-014 Broker narzędzi jako granica, runtime jako niezaufany

Model tylko proponuje `{tool, params}`. Broker: narzędzie musi być dozwolone w kontekście (np. NovaAI nie ma
`household.notify`), parametry walidowane zod, autoryzacja zasobowa przy planowaniu i przy wykonaniu, audyt
`tool.plan`/`tool.execute` (skrót parametrów, bez treści). `FakeAgentRuntime` celowo proponuje narzędzia
niezależnie od `allowedCapabilities`, by testy sprawdzały broker (m.in. prompt injection w NovaAI).

## D-015 PWA

Router hash (bez zależności), `EventSource` do SSE z resynchronizacją widoków po (ponownym) połączeniu,
service worker buforuje wyłącznie powłokę i zasoby `/assets/*` — nigdy `/api`. Desktop: nawigacja + treść +
Activity Strip (≥1180 px); telefon (<900 px): górny pasek + dolna nawigacja Czat/Zadania/Dom/Pamięć.
E2E: Playwright 1.56.1 (zgodny z preinstalowanym Chromium), baza `nova_e2e` resetowana przy starcie.

## D-016 ModelGateway, cenniki z konfiguracji, budżet z rezerwacją

- `AgentRuntime` (kontrakt) → `ModelAgentRuntime` (gdy jest dostępny model) albo `FakeAgentRuntime`
  (jawny tryb demo). `ModelGateway.complete()` ukrywa dostawców: trasa per zdolność (`chat.simple` /
  `chat.complex`, opcjonalnie per profil runtime), wymaganie prywatności (`dataPolicy`: kontekst prywatny ⇒
  tylko `private_ok`), fallback przy błędach przejściowych.
- **Nazwy modeli i ceny wyłącznie w pliku konfiguracyjnym** (`infra/config/models.example.json`,
  `NOVA_MODELS_CONFIG`). Model płatny bez kompletnego cennika albo bez kursu waluty (`fx`, ustawiany przez
  operatora) jest niedostępny — inaczej nie da się egzekwować budżetu. Przykładowa konfiguracja ma ceny `null`
  ⇒ świeża instalacja działa w trybie demo, bez żadnych płatnych wywołań.
- Koszt = tokeny × cena/MTok × kurs, w mikro-jednostkach waluty budżetu (bigint). Brak `usage` od dostawcy
  ⇒ szacunek znaki/4 oznaczony `estimated=true` i pokazywany jako estymacja.
- Budżet miesięczny per dom (`budgets`, strefa Europe/Warsaw): przed płatnym wywołaniem rezerwacja
  najgorszego przypadku (wejście znaki/3 + pełne `max_tokens`) pod `pg_advisory_xact_lock` per dom; po odpowiedzi
  rozliczenie rzeczywistym kosztem. Równoległe wywołania nie przekroczą twardego limitu (test).
  Po twardym limicie/wyłączeniu płatnych wywołań: brak wywołania modelu, jawny komunikat w czacie, zdarzenie
  `budget.blocked`; modele bezpłatne, dane lokalne, zadania i zgody działają dalej. Próg ostrzeżenia ⇒ jedno
  zdarzenie `budget.warning`, a trasa `chat.complex` spada do `chat.simple`.
- Limity ustawia każdy aktywny domownik (`PUT /api/budget`), zmiana audytowana i widoczna dla obojga.

## D-017 Adapter Anthropic przez oficjalny SDK; Hermes jako endpoint OpenAI-compatible z warunkiem

- Claude: `@anthropic-ai/sdk` (0.128), Messages API, narzędzia jako `tools` + `tool_choice: auto`, nazwy
  narzędzi `memory.create` ⇄ `memory__create` (wymóg `^[a-zA-Z0-9_-]{1,64}$`), `output_config.effort` z konfiguracji,
  `stop_reason: refusal` obsłużone jawnie. Typowane wyjątki SDK mapowane na `ProviderError(retryable)`.
  Testy kontraktowe: SDK kierowany `baseURL` na lokalny serwer-mock (bez sieci i kosztów). Server-side
  `fallbacks` (beta) nie są włączone — fallback realizuje trasa w konfiguracji.
- Hermes (zweryfikowane 2026-09-25 w dokumentacji API server i profiles): `POST /v1/chat/completions`
  zgodny z OpenAI, `Authorization: Bearer <API_SERVER_KEY>`, domyślnie `127.0.0.1:8642`, profil = model ID,
  osobny klucz i port per profil (`~/.hermes/profiles/<p>/.env`). **Hermes wykonuje po swojej stronie własny
  zestaw narzędzi (terminal, pliki, web, pamięć, skills)** — to omijałoby broker i ACL NovaAI. Dlatego dostawca
  typu Hermes jest niedostępny, dopóki operator nie ustawi `hermes.toolsetsDisabledConfirmed: true` po
  wyłączeniu toolsetów w `config.yaml` profilu. Trzy profile (`private-<user>`, `household`) mapują się przez
  `profileRoutes`; nie należy wskazywać dwóch procesów na ten sam `HERMES_HOME` (ostrzeżenie z dokumentacji).
  Adapter przetestowany kontraktowo na mocku; **nie uruchomiony przeciwko prawdziwemu Hermesowi** (brak
  instalacji i kluczy w tej sesji).
- Honcho (pamięć epizodyczna): nie zaimplementowano; lokalna trwała pamięć w Postgres działa bez niego.

## D-018 Worker: protokół v1, dwa klucze, dwie warstwy walidacji ścieżek

- Połączenie wyłącznie wychodzące (WebSocket `/api/device-link/connect`, TLS wymagane poza localhost —
  sprawdzane w Workerze). Parowanie: jednorazowy kod 8 znaków (40 bitów) ważny 10 min, przechowywany jako
  SHA-256; limiter 10 nieudanych prób/min/IP. Urządzenie generuje własny klucz Ed25519; serwer zapisuje klucz
  publiczny. Serwer podpisuje polecenia i granty kluczem wyprowadzonym HKDF z `NOVA_SECRET_KEY`
  (stały między restartami; Worker przypina go przy parowaniu). W dev bez sekretu — jawnie niebezpieczny klucz dev.
- Uwierzytelnienie połączenia: challenge (nonce) → `hello` podpisane kluczem urządzenia → `welcome` + podpisane granty.
- Polecenie: `v, commandId, deviceId, taskId, capability, params, idempotencyKey, issuedAt, deadline`
  podpisane przez serwer; wynik podpisany przez urządzenie i dopasowany do oczekującego polecenia i klucza.
  Podpis obejmuje dokładne bajty `payload` (string JSON) — brak problemów z kanonikalizacją między TS i Rust.
- Warstwa 1 (DeviceBroker, przed wysyłką): właściciel, kontekst (NovaAI bez urządzeń), aktywny grant zdolności,
  leksykalnie katalog (także reguły Windows: ADS, CON/NUL, UNC, `..`). Warstwa 2 (Worker): lokalna polityka
  z `worker.toml` ∩ podpisane granty, ścieżka kanoniczna (realpath/`dunce::canonicalize` — symlinki i junctions),
  zakaz zapisu przez link/reparse point. Serwer może tylko zawęzić dostęp.
- Zapis: zawsze przez zgodę z diffem (jsdiff) i zamrożonym `baseSha256`; Worker odmawia przy zmianie pliku,
  robi kopię zapasową w katalogu stanu (poza udostępnionym katalogiem) i atomową zamianę (tmp + rename).
- Wyniki narzędzi urządzeń mają klasyfikację `private` — zapisywane wyłącznie w prywatnej rozmowie właściciela.
- Symulator TS (`apps/api/src/devices/simulator.ts`) jest implementacją referencyjną używaną w testach i e2e;
  Worker Rust przechodzi ten sam scenariusz w teście interoperacyjności (`rust-worker.test.ts`).
- Ograniczenia: hub połączeń jest w pamięci procesu (jedna instancja API); klucz urządzenia na Windows bez DPAPI;
  brak procesów/aplikacji/PowerShell/zrzutów/UI Automation (kolejne kroki sekcji 6 specyfikacji).
- TLS w Workerze jako cecha `tls` (domyślna) — pozwala sprawdzić kompilację kodu `cfg(windows)` z Linuksa bez
  kompilatora C mingw (`pnpm worker:check-windows`).

## D-019 Integracje: kontrakt Connector, sejf tokenów, Google jako pierwszy dostawca

- `Connector` (`apps/api/src/connectors/types.ts`): capabilities, connect (authorizeUrl/exchangeCode),
  disconnect (revoke), refresh, zdolności opcjonalne (freeBusy, mailSearch/Read/Send). Brak konfiguracji ⇒
  `configured: false` z powodem; UI pokazuje „niedostępne”, a narzędzia nie są oferowane modelowi.
- Sejf (`vault.ts`): AES-256-GCM, klucz HKDF z `NOVA_SECRET_KEY`, AAD = `użytkownik|dostawca|id połączenia`
  (podmiana rekordów wykrywana), identyfikator klucza przy szyfrogramie; rotacja: nowy `NOVA_SECRET_KEY(_ID)`
  - `NOVA_SECRET_KEYS_OLD`, potem `pnpm --filter @nova/api db:rotate-keys`. Rola `nova_app` nie ma prawa odczytu
    kolumny z szyfrogramem.
- OAuth: `state` (256 bit, jednorazowy, 10 min, w bazie skrót) + PKCE S256 (weryfikator zaszyfrowany w bazie).
  Callback nie wymaga ciasteczka (SameSite=Strict nie jest wysyłane z domeny dostawcy) — użytkownika wiąże `state`.
- Google (zweryfikowane 2026-09-25 w oficjalnej dokumentacji): auth `https://accounts.google.com/o/oauth2/v2/auth`,
  token `https://oauth2.googleapis.com/token`, revoke `https://oauth2.googleapis.com/revoke`; `access_type=offline`,
  `include_granted_scopes=true`. Minimalne zakresy: `calendar.freebusy` (freeBusy `POST /calendar/v3/freeBusy`),
  `gmail.readonly` (search/read), `gmail.send` (`POST /gmail/v1/users/me/messages/send`, `raw` base64url RFC 2822).
  Uwaga do weryfikacji przed produkcją: `gmail.readonly` to zakres „restricted”, `gmail.send` „sensitive” —
  aplikacja zewnętrzna wymaga weryfikacji Google; w trybie „Testing” refresh tokeny wygasają po ok. 7 dniach.
- Free/busy dla NovaAI: tabela `calendar_grants` (jawny grant właściciela, cofany natychmiast). Narzędzie
  `calendar.freebusy` zwraca wyłącznie przedziały zajętości osób z aktywnym grantem (Google lub kalendarz lokalny),
  nigdy tytułów. Agent prywatny widzi tylko własną zajętość.
- Poczta: tylko agent prywatny; wyniki `resultVisibility: private`. `mail.send` zawsze ze zgodą (podgląd adresata,
  tematu i treści), walidacja przeciw wstrzyknięciu nagłówków, `nonIdempotentExternal` — przerwana wysyłka nie jest
  ponawiana automatycznie (`outcome_unknown_needs_review`). Treść maila to dane: trafia jako wiadomość `tool`
  i nie jest przekazywana modelowi jako polecenie (runtime modelu używa tylko ról user/assistant).
- Webhooki: `POST /api/webhooks/slack` — HMAC `v0` z `SLACK_SIGNING_SECRET`, okno 5 min, `url_verification`,
  deduplikacja po `event_id` (`webhook_deliveries`). Mapowanie zdarzeń na użytkowników/zadania — nie zaimplementowano.
- Google Pub/Sub push (JWT OIDC) i odnawianie subskrypcji (watch/Graph) — nie zaimplementowano. Microsoft (Outlook) —
  patrz D-027, Slack — D-028.

## D-020 Proaktywność (M6): przypomnienia w trwałej kolejce, prywatność i koszt przed akcją

- Przypomnienie = rekord `reminders` + zadanie `reminder.fire` z `run_after = due_at` w tej samej kolejce co
  reszta (przeżywa restart, lease, odzysk). Dostarczenie jest deterministyczne: bez modelu, bez poczty,
  więc działa także przy zablokowanym budżecie (test).
- Prywatne przypomnienie trafia wyłącznie do właściciela; wspólne — do aktywnych członków domu. Przed
  dostarczeniem kolejka ładuje świeże członkostwa: po odebraniu członkostwa autora nic nie jest wysyłane.
  Powiadomienia mają klucz idempotencji `reminder:<id>:<odbiorca>` (brak duplikatów po ponowieniu).
- Limity: maks. 50 aktywnych przypomnień na osobę, termin od „teraz” (tolerancja 60 s) do 1 roku.
- Agent: `reminder.create` — prywatny agent tworzy przypomnienia prywatne, NovaAI wspólne; bez zgody (dotyczy
  wyłącznie autora lub przestrzeni wspólnej, w której padła prośba).
- Powiadomienia push (Web Push/VAPID) — nie zaimplementowano; powiadomienia są w aplikacji (SSE + lista w „Dom”).
- Głos: dyktowanie przez Web Speech API przeglądarki (opt-in z jawną informacją, że w Chrome/Edge mowa jest
  przetwarzana na serwerach dostawcy przeglądarki) i odczyt odpowiedzi przez `speechSynthesis`. Brak nagrań
  po stronie serwera i brak kosztów modeli. Transkrypcja serwerowa (płatna) — nie zaimplementowano.

## D-021 Passkeys (WebAuthn) i bootstrap produkcji bez logowania testowego

- `@simplewebauthn/server` 14 / `@simplewebauthn/browser` 14. Klucze rezydentne (discoverable), wymagana
  weryfikacja użytkownika (UV), attestation `none`. RP ID = domena (`NOVA_RP_ID`, domyślnie host z
  `NOVA_WEB_ORIGIN`), originy `NOVA_RP_ORIGINS`. IP nie jest poprawnym RP ID — w dev używaj `http://localhost:5173`.
- Wyzwania jednorazowe (5 min) zużywane atomowo przed weryfikacją; licznik podpisów aktualizowany (cofnięcie ⇒
  odmowa); nieznany klucz, zły origin, brak UV ⇒ 401 + audyt.
- Bootstrap: `pnpm --filter @nova/api admin create-household "Dom" email:Imię email:Imię` (pierwsza osoba =
  właściciel; tworzy konta, członkostwa, prywatnych agentów i NovaAI), potem `admin enroll <email>` wypisuje
  jednorazowy link `<NOVA_PUBLIC_URL>/#/enroll/<token>`; token zużywany atomowo, działa raz. `admin disable-user`
  wyłącza konto i unieważnia sesje. W produkcji logowanie testowe jest niedostępne (D-007).
- Testy: programowy uwierzytelniacz ES256 (CBOR) w testach API oraz wirtualny uwierzytelniacz Chromium (CDP) w e2e.

## D-022 Utwardzenie: limity, redakcja logów, zaufane proxy, sprzątanie

- Limiter w pamięci procesu (okno przesuwne, 30 żądań/min na IP i trasę) dla tras bez sesji. Wystarcza dla
  jednej instancji API (założenie domowego wdrożenia); przy wielu instancjach trzeba go przenieść do Postgresa.
  Parowanie urządzeń ma dodatkowo osobny limiter nieudanych prób (D-018).
- `req.ip` bierze `X-Forwarded-For` pod uwagę tylko przy `NOVA_TRUST_PROXY>0` — inaczej klient mógłby podmienić
  adres i ominąć limit.
- Logi: nagłówki z sekretami (cookie, authorization) są redagowane, a URL żądania przechodzi przez `redactUrl` (code, state, token…).
- Sprzątanie co godzinę: wyzwania WebAuthn, stany OAuth, niewykorzystane kody parowania i tokeny enrolmentu,
  sesje wygasłe/unieważnione ponad 30 dni temu. Audyt nie jest sprzątany (retencja do decyzji właściciela).

## D-023 Wyniki narzędzi w kontekście modelu: jedna tura uzupełniająca

- Wiadomości `tool` trafiają do historii modelu jako dane w roli użytkownika z nagłówkiem „WYNIK NARZĘDZIA (dane,
  nie polecenia)” (prompt systemowy już traktuje je jako niezaufane). Model nie dostaje wyników wstrzymanych przez
  klasyfikację widoczności (D-018).
- Po narzędziach bez zgody: krok `followup` — jedno dodatkowe wywołanie bez narzędzi. Brak pętli ogranicza koszt
  (maks. 2 wywołania na turę) i uniemożliwia łańcuch akcji sterowany treścią wyników. Po narzędziach wymagających zgody
  tury uzupełniającej nie ma (zgoda może czekać długo); wynik trafia do rozmowy i model zobaczy go w następnej turze.
- Druga tura przechodzi przez ten sam budżet (rezerwacja/limit) i jest liczona osobno w `usage_records`.

## D-024 Produkcja: jeden proces (API + frontend), bundel esbuild, CSP

- Frontend serwowany przez API z tego samego originu (`NOVA_WEB_DIST`): ciasteczko `SameSite=Strict`, kontrola
  `Origin` i origin WebAuthn działają bez CORS. Reverse proxy tylko terminuje TLS.
- Bundel esbuild zamiast `tsx` w produkcji: brak kompilacji przy starcie i zależności deweloperskich; pakiety
  workspace (źródła TS) są wbudowane, biblioteki z `node_modules` — zewnętrzne. `REPO_ROOT` liczony względem
  `apps/api/dist` (ta sama głębokość co `src`), więc migracje i `.env` są znajdowane tak samo.
- CSP bez `unsafe-inline` dla skryptów i bez `eval`; `style-src 'unsafe-inline'` tylko dla atrybutów `style`
  w React. Frontend nie importuje zod (patrz PROGRESS) — walidacja wejścia i tak odbywa się na serwerze.

## D-025 Pamięć dokumentów: Postgres FTS, oryginał w bazie, uprawnienia przed fragmentami

- Oryginał pliku w `document_blobs` (bytea): ponowne indeksowanie ulepszonym parserem i pobranie bez osobnego
  magazynu plików i jego kopii zapasowych. Limit 10 MB na plik i 200 MB na osobę trzyma rozmiar bazy w ryzach.
- Wyszukiwanie pełnotekstowe Postgres (`simple` + normalizacja w aplikacji + prefiksy dla polskiej odmiany + IDF)
  zamiast embeddingów: bez płatnego API i bez modelu lokalnego, deterministyczne i testowalne. Ograniczenie:
  brak dopasowań semantycznych — do rozważenia pgvector z lokalnym modelem embeddingów.
- Kolejność: dokumenty dozwolone w kontekście (RLS + `decide`) ⇒ dopiero wtedy zapytanie o fragmenty ograniczone do
  ich ID. Fragmenty mają skopiowane właściciela/dom/widoczność (zmieniane w tej samej transakcji co dokument), więc RLS
  działa także bez złączeń.
- PDF w `worker_threads` z limitem czasu i pamięci, `isEvalSupported: false`, bez czcionek i XFA — plik jest
  niezaufanym wejściem. Plik wątku (`pdf-worker.mjs`) jest czystym JS, kopiowanym do `dist/` przy budowie bundla.
- Pobieranie oryginału zawsze jako załącznik z `Content-Security-Policy: sandbox` (plik nie renderuje się w originie
  aplikacji). Zadanie indeksowania jest zawsze prywatne (tytuł zawiera nazwę pliku).

## D-026 Niezaufany kontekst wymusza zgodę na akcje

- Jeśli w turze modelu są fragmenty dokumentów lub wyniki narzędzi (np. treść e-maila, pliku), każde zaproponowane
  narzędzie ze skutkami wymaga zgody człowieka, nawet gdy zwykle jej nie wymaga (`memory.create`, `reminder.create`).
  Narzędzia tylko do odczytu (`readOnly`) — bez zmian. Obrona nie zależy od tego, czy model oprze się wstrzyknięciu.
- Broker sprawdza zgodę (stan, właściciel, krok, skrót parametrów) zawsze, gdy krok ją ma — także gdy wymusił ją
  kontekst, a nie definicja narzędzia.

## D-027 Microsoft Graph: Outlook — poczta i kalendarz (uprawnienia delegowane, osobno dla każdego użytkownika)

Źródła: oficjalna dokumentacja Microsoft Learn, sprawdzona 2026-09-26 — Microsoft identity platform (authorization
code flow v2.0 z PKCE, uprawnienia i zgody, refresh tokeny), Microsoft Graph v1.0 (list messages, get message,
sendMail, create message, calendarView, parametr `$search`, stronicowanie `@odata.nextLink`, nagłówki `Prefer`),
uprawnienia Teams (list channel messages, list chat messages) i instrukcje cofania zgody aplikacji. **Nic z tego nie
zostało sprawdzone na prawdziwym koncie ani dzierżawie Microsoft** — tylko na lokalnej atrapie odtwarzającej kontrakt.

- Logowanie: `https://login.microsoftonline.com/{MICROSOFT_TENANT}/oauth2/v2.0/authorize` i `/token`, kod
  autoryzacyjny + PKCE S256, klient poufny (`client_secret`), `response_mode=query`, `prompt=select_account` (wybór
  konta zamiast cichego użycia zalogowanego). Domyślnie `common` (konta osobiste i służbowe). Każdy użytkownik NovaAI
  łączy własne konto; tokeny w sejfie jak w D-019 (AAD = użytkownik|dostawca|połączenie). `state` jednorazowy.
- Najmniejsze uprawnienia (delegowane) per zdolność; w żądaniu tylko te, które użytkownik zaznaczył:

  | Zdolność            | Endpoint Graph v1.0                                                   | Uprawnienie           |
  | ------------------- | --------------------------------------------------------------------- | --------------------- |
  | `mail.search`       | `GET /me/messages?$search=…&$select=id,subject,from,receivedDateTime` | `Mail.ReadBasic`      |
  | `mail.read`         | `GET /me/messages/{id}` + `Prefer: outlook.body-content-type="text"`  | `Mail.Read`           |
  | `mail.send`         | `POST /me/sendMail` (202, kopia w Elementach wysłanych)               | `Mail.Send`           |
  | `mail.draft` (opc.) | `POST /me/messages` (201, szkic; zwraca `webLink`)                    | `Mail.ReadWrite`      |
  | `calendar.freebusy` | `GET /me/calendarView` + `$select=start,end,showAs,isCancelled`       | `Calendars.ReadBasic` |
  | `calendar.read`     | `GET /me/calendarView` (+ tytuł, miejsce, cały dzień)                 | `Calendars.ReadBasic` |

  Zawsze także `offline_access` (refresh token), `openid`, `profile` (etykieta konta z tokenu ID — tylko do
  wyświetlenia). `Mail.ReadBasic` nie obejmuje treści ani podglądu — wyniki wyszukiwania nie mają wycinka.
  Szersze uprawnienie zastępuje węższe (`Mail.Read` ⊃ `Mail.ReadBasic`). `Mail.ReadWrite` (zmiana i usuwanie poczty)
  wyłącznie dla szkiców i wyłącznie po świadomym zaznaczeniu — wysyłka i szkice są w UI domyślnie wyłączone.

- Jedno uprawnienie może obejmować kilka zdolności (`Calendars.ReadBasic` = zajętość i tytuły wydarzeń), więc
  połączenie zapisuje też wybór użytkownika (`connections.capabilities`, migracja 0011); aplikacja udostępnia tylko
  część wspólną wyboru i przyznanych zakresów. Zakresy porównywane w postaci kanonicznej (Microsoft zwraca
  „Mail.Read” zamiast pełnego URI i dodaje wcześniej przyznane, np. `User.Read`).
- Czas wydarzeń: `Prefer: outlook.timezone="UTC"` (Graph zwraca czas bez przesunięcia) → ISO z `Z`. Stronicowanie
  tylko po adresach w obrębie Graph (maks. 10 stron); odwołane wydarzenia pomijane; `showAs: free` nie jest zajętością.
- Tokeny: Microsoft może zwrócić nowy refresh token — zastępuje poprzedni. Odświeżenie pod blokadą wiersza
  (`SELECT … FOR UPDATE`), więc równoległe zadania odświeżają raz. HTTP 401 z Graph ⇒ jedno wymuszone odświeżenie
  i jedno ponowienie (bezpieczne także dla wysyłki — odrzucone żądanie nie zostało wykonane); drugie 401 albo
  `invalid_grant` / `interaction_required` / `consent_required` przy odświeżeniu ⇒ status „wymaga ponownego
  połączenia”, bez dalszych wywołań. 403 ⇒ brak uprawnienia (także zasady organizacji); 429/5xx ⇒ ponowienie zadania.
- Odłączenie: Microsoft nie ma endpointu odwołania pojedynczego tokenu aplikacji (unieważnienie sesji użytkownika
  wylogowałoby go ze wszystkich aplikacji), więc NovaAI usuwa tokeny u siebie, a Ustawienia pokazują, jak cofnąć zgodę:
  konto osobiste — account.microsoft.com → Prywatność → dostęp aplikacji; konto służbowe — Moje aplikacje
  (myapps.microsoft.com) → Zarządzaj aplikacją → Cofnij uprawnienia. Wydany wcześniej token dostępu wygasa sam.
- Narzędzia: poczta i szczegóły kalendarza tylko dla agenta prywatnego (`resultVisibility: private`); NovaAI dostaje
  wyłącznie przedziały zajętości osób z grantem (D-019), a trwały błąd konta jednej osoby daje „kalendarz wymaga
  ponownego połączenia konta” zamiast błędu całej odpowiedzi. Wysyłka i szkic zawsze przez zgodę (podgląd skrzynki
  nadawcy z etykietą konta, odbiorcy i treści); konto jest ustalane przy planowaniu i należy do parametrów objętych
  skrótem zgody. Dwa połączone konta z tą samą funkcją ⇒ odmowa „wskaż konto” (Outlook/Gmail), bez zgadywania.
- Teams — **niezaimplementowane**, pokazane w Ustawieniach: odczyt wiadomości kanałów wymaga
  `ChannelMessage.Read.All`, na które zgodę musi wyrazić administrator organizacji; czaty (`Chat.Read`) działają tylko
  na kontach służbowych/szkolnych; konta osobiste Microsoft nie mają dostępu do API Teams.
- Konta służbowe: zasady zgód dzierżawy mogą wymagać zatwierdzenia administratora także dla poczty i kalendarza.
  Microsoft zwykle pokazuje wtedy własny ekran „wymagana zgoda administratora” (bez powrotu do NovaAI); jeśli wraca
  z błędem, callback rozpoznaje to po `consent_required` lub kodach AADSTS w `error_description` (m.in. 90094, 65001)
  i pokazuje komunikat „organizacja wymaga zgody administratora”. Rozpoznanie jest heurystyczne; treść opisu błędu
  nie jest zapisywana (audyt ma tylko krótki kod i wyprowadzony powód).
- Poza zakresem: subskrypcje zmian (webhooki Graph), zapis w kalendarzu, załączniki, foldery i wątki poczty.

## D-028 Slack: token użytkownika, wyszukiwanie na żywo bez zapisu, wysyłka przez zgody

Źródła: oficjalna dokumentacja Slack (docs.slack.dev), sprawdzona 2026-09-26 — instalacja z OAuth v2
(`oauth/v2/authorize`, `oauth.v2.access`, `user_scope`), PKCE, rotacja tokenów, `auth.test`, `auth.revoke`,
Real-time Search API i `assistant.search.context`, `search.messages` (oznaczone jako przestarzałe),
`conversations.info`, `chat.postMessage`, Events API (ponowienia) oraz zdarzenia `tokens_revoked` i `app_uninstalled`.
**Nic z tego nie zostało sprawdzone na prawdziwym workspace Slack** — tylko na lokalnej atrapie odtwarzającej kontrakt.

- Każda osoba łączy własne konto: wyłącznie zakresy UŻYTKOWNIKA (`user_scope`, token `xoxp`), bez zakresów bota.
  Tożsamość tokenu potwierdza `auth.test` (bez zakresów); workspace i użytkownik Slack są zapisywane przy połączeniu
  (migracja 0012). Jedno konto Slack może być połączone tylko z jedną osobą NovaAI (unikalny indeks) — druga próba
  kończy się komunikatem „połączone przez inną osobę”, bez odwołania tokenu (Slack może zwrócić ten sam token).
- Bez PKCE: w Slacku włączenie PKCE zmienia aplikację w klienta publicznego (bez sekretu, nieodwracalnie, refresh
  tokeny ważne 30 dni). NovaAI jest klientem poufnym: sekret klienta + jednorazowy `state` wiążący osobę.
  Redirect URL musi być HTTPS (lokalnie potrzebny tunel).
- Najmniejsze zakresy per zdolność (użytkownik wybiera w Ustawieniach; domyślnie tylko kanały publiczne):

  | Zdolność            | Metoda Slack                              | Zakresy użytkownika                          |
  | ------------------- | ----------------------------------------- | -------------------------------------------- |
  | `chat.read`         | `assistant.search.context` (kanały publ.) | `search:read.public`                         |
  | `chat.read_private` | j.w. + `private_channel`                  | + `search:read.private`                      |
  | `chat.read_dm`      | j.w. + `im`, `mpim`                       | + `search:read.im`, `search:read.mpim`       |
  | `chat.send`         | `conversations.info`, `chat.postMessage`  | `chat:write`, `channels:read`, `groups:read` |

  Odczyt przez Real-time Search API, nie przez `search.messages`/`search:read` (dokumentacja: nie używać). Wzmianki
  = wyszukiwanie `<@ID_UŻYTKOWNIKA>` od najnowszych (`sort=timestamp`, bez wyszukiwania semantycznego) z ostatnich
  N dni. Slack zwraca wyłącznie wiadomości z rozmów, do których należy ta osoba.

- **Brak zapisu treści**: zasady Real-time Search API zabraniają przechowywania i kopiowania pobranych danych.
  Narzędzia `slack.mentions` / `slack.search` zapisują tylko liczbę wyników i parametry (`live`); treść jest
  pobierana na żywo — w czacie przyciskiem „Pokaż na żywo” (`POST /api/connections/slack/live`, `Cache-Control:
no-store`, tokenem pytającej osoby) oraz dla modelu w turze uzupełniającej (nie trafia do bazy). Odpowiedź asystenta
  (podsumowanie) jest zapisywana jak każda odpowiedź — to zamierzone użycie API w aplikacjach AI. Test sprawdza całą
  bazę pod kątem treści ze Slacka.
- Dostępność Real-time Search API: tylko aplikacje wewnętrzne (utworzone w danym workspace) albo opublikowane
  w Slack Marketplace — aplikacja „rozproszona, niepublikowana” nie może z niego korzystać; przeznaczone dla aplikacji
  z funkcjami AI; limit ok. 10 zapytań/min na użytkownika. Dla domu w jednym workspace: aplikacja wewnętrzna.
  Workspace z zatwierdzaniem aplikacji wymaga zgody administratora przed połączeniem.
- Wysyłka (`slack.send`) jako ta osoba, zawsze po zgodzie, `nonIdempotentExternal`, bez rozwijania linków. Nazwa
  kanału, członkostwo i archiwizacja pochodzą z `conversations.info` przy planowaniu (nadpisują cokolwiek podał model),
  więc podgląd zgody pokazuje prawdziwy cel i konto nadawcy. Tylko kanały publiczne i prywatne (także odpowiedź
  w wątku); rozmowy bezpośrednie i grupowe — nieobsługiwane (wymagałyby `im:read`, `mpim:read`, `users:read`).
- Tokeny: bez rotacji nie wygasają; przy włączonej rotacji (ustawienie aplikacji) 12 h i jednorazowy refresh token —
  odświeżanie pod blokadą wiersza, `token_expired` ⇒ jedno odświeżenie i ponowienie. `invalid_auth`, `token_revoked`,
  `account_inactive` ⇒ „wymaga ponownego połączenia”. `missing_scope` ⇒ brak uprawnienia; 429/`ratelimited`, błędy
  5xx, brak sieci i przekroczony czas ⇒ błąd przejściowy (ponowienie kroku, w API na żywo 503); błędy kanału
  (`not_in_channel`, `is_archived`, `channel_not_found`, `restricted_action`) i wyłączone wyszukiwanie ⇒ czytelna odmowa.
- Odłączenie: `auth.revoke` tokenem tej osoby, potem usunięcie tokenów lokalnie; brak potwierdzenia od Slacka (np. brak
  sieci) ⇒ tokeny i tak usunięte, a komunikat prosi o usunięcie aplikacji w Slacku.
- Events API (`POST /api/webhooks/slack`): podpis HMAC `v0` z `SLACK_SIGNING_SECRET`, okno 5 min, `url_verification`.
  Obsługiwane `tokens_revoked` (lista `oauth` = użytkownicy) i `app_uninstalled` (cały workspace): połączenia dostają
  stan „dostęp cofnięty w Slacku”, tokeny są usuwane, właściciel dostaje powiadomienie. Deduplikacja po `event_id`
  i przetworzenie w jednej transakcji: ponowienie Slacka (`x-slack-retry-num`: od razu, po 1 min, po 5 min) po udanym
  przetworzeniu jest tylko liczone (`webhook_deliveries.duplicates`); błąd przetwarzania ⇒ wycofanie i 500, więc
  ponowienie przetwarza zdarzenie. Odpowiedź w < 3 s (tylko operacje w bazie). Inne zdarzenia: `ignored`, bez treści.
- Poza zakresem: powiadomienia push o nowych wzmiankach (wymagałyby subskrypcji zdarzeń wiadomości i zakresów
  `*:history`), pliki, reakcje, edycja i usuwanie wiadomości, instalacje Enterprise Grid (org-wide).

## D-029 Usługi i koszty: rejestr usług, jedna opłata liczona raz, adaptery raportów kosztów

Źródła adapterów (sprawdzone 2026-09-26): Anthropic — Usage and Cost API
(platform.claude.com/docs/en/manage-claude/usage-cost-api) i referencja „Get Cost Report”
(platform.claude.com/docs/en/api/beta/organization/cost_report/retrieve); OpenAI — Costs API (opis i przykład
odpowiedzi w developers.openai.com/cookbook/examples/completions_usage_api; strona referencji API była niedostępna
dla pobierania automatycznego). **Adaptery nie zostały sprawdzone na prawdziwych kontach** — tylko na atrapie.

- Dane: `services` (cel, właściciel, link do panelu, okres rozliczeniowy, waluta, plan, data odnowienia, dni
  przypomnienia, miesięczny budżet, status, notatki) i `service_costs` (szacunek / raport dostawcy / faktura;
  faktura opłacona = z datą zapłaty). Kwoty w mikro-jednostkach (jak `usage_records`), bez liczb zmiennoprzecinkowych.
  Waluta ISO 4217 (Intl); wpis ręczny nie może mieć więcej miejsc po przecinku niż waluta (JPY 0, PLN 2).
- Prywatność jak w pozostałych danych: prywatna usługa — tylko właściciel; wspólna — członkowie domu czytają,
  zmienia wyłącznie właściciel (polityka `service.*` + RLS; wpisy kosztów widoczne razem z usługą). Moduł nie ma
  narzędzi agenta — modele nie zmieniają usług ani kosztów.
- **Każda opłata liczona raz**: w obrębie jednej usługi i jednego miesiąca suma bierze jedno źródło — faktury, a gdy
  ich nie ma, raport dostawcy, a dopiero potem szacunek (wpisy ręczne + koszt zapisanych wywołań modeli). Wpisy
  „przegrane” są pokazywane jako niewliczone. Dostawca modeli i adapter kosztów mogą być przypisane do najwyżej jednej
  usługi w domu (unikalny indeks), więc ten sam koszt nie trafi do dwóch usług; odmowa nie ujawnia cudzej usługi.
- Szacunek z wywołań modeli: `usage_records` danego domu i dostawcy z konfiguracji modeli (płatne, bez nieudanych).
  Miesiące w UTC — tak liczą raporty dostawców.
- Waluty nie są sumowane ani przeliczane: suma miesiąca i sumy usług są osobno dla każdej waluty; budżet porównuje
  tylko kwoty w walucie usługi (inne waluty są wskazane jako nieporównane). Stan budżetu: „blisko” od 80 %,
  „przekroczony” powyżej 100 %; jedno powiadomienie na usługę i miesiąc (klucz idempotencji), dla właściciela albo
  — przy usłudze wspólnej — dla domowników.
- Faktury: deduplikacja w obrębie usługi po znormalizowanym numerze (wielkość liter, spacje), a bez numeru — po dacie
  wystawienia (lub miesiącu), kwocie i walucie. Import CSV (`numer;data_wystawienia;kwota;waluta;miesiac;data_zaplaty`)
  najpierw waliduje całość (błędy z numerami linii ⇒ nic nie jest zapisane), a powtórny import pomija zapisane faktury.
- Odnowienia: przypomnienie przez trwałą kolejkę `N` dni przed datą o 9:00 czasu polskiego (czas letni uwzględniony);
  zmiana daty, statusu lub widoczności przestawia przypomnienie, anulowanie/usunięcie usługi je odwołuje. Termin już
  bliski ⇒ przypomnienie od razu; data minęła lub dalej niż rok ⇒ ostrzeżenie zamiast przypomnienia. „Odnowiono”
  przesuwa datę o okres (miesiąc, kwartał, rok) z zachowaniem dnia miesiąca (31.01 → 28/29.02 → 31.03); usługi
  jednorazowe i rozliczane za użycie — data ręcznie.
- Bez haseł i kluczy: pola wyglądające na klucze API, tokeny lub hasła są odrzucane z komunikatem; link do panelu tylko
  `https://`, bez danych logowania i parametrów typu `token`/`key`. Klucze administracyjne adapterów tylko w
  zmiennych środowiskowych serwera (`ANTHROPIC_ADMIN_API_KEY`, `OPENAI_ADMIN_API_KEY`); API zwraca wyłącznie
  „klucz skonfigurowany: tak/nie”, audyt i błędy synchronizacji nie zawierają kluczy.
- Adaptery (odczyt raportów organizacji, rozszerzalny interfejs `CostAdapter`):
  - Anthropic: `GET /v1/organizations/cost_report`, nagłówki `x-api-key` (klucz administracyjny `sk-ant-admin…`)
    i `anthropic-version: 2023-06-01`, kubełki dzienne (`limit` ≤ 31), stronicowanie `has_more`/`next_page`; kwota
    to tekst dziesiętny w centach, waluta USD. Admin API niedostępne dla kont indywidualnych; koszty Priority Tier
    poza raportem; dane pojawiają się zwykle w ciągu ok. 5 minut, zalecane odpytywanie najwyżej raz na minutę.
  - OpenAI: `GET /v1/organization/costs`, `Authorization: Bearer` z kluczem administracyjnym, `start_time`/`end_time`
    w sekundach Unix, `bucket_width=1d`, `limit` 1–180, stronicowanie `has_more`/`next_page`; `amount.value`
    w dolarach, `amount.currency` („usd”).
  - Synchronizacja na żądanie właściciela usługi z przypisanym adapterem: poprzedni i bieżący miesiąc, jeden wpis
    „raport dostawcy” na miesiąc i walutę, aktualizowany przy kolejnej synchronizacji (bez duplikatów).
  - Stan w UI: „niepodłączone” (brak klucza / brak udanej synchronizacji / błąd ostatniej próby) dopóki
    synchronizacja rzeczywiście się nie uda; „podłączone” tylko po udanej synchronizacji.
- Poza zakresem: adaptery VPS, domen i kopii zapasowych (wpisy ręczne lub import CSV), automatyczna synchronizacja
  w tle, przeliczanie walut, korekty ujemne (zwroty) — do rozważenia z aktualną dokumentacją każdego dostawcy.
- Gałąź bazowa: `claude/novaai-slack` — najnowsza gałąź z pamięcią dokumentów (zawiera też Microsoft, Slack
  i poprawkę czarnego ekranu).

## D-030 Modele AI i klucze API dodawane w aplikacji

Prośba: dodawanie kluczy Anthropic, OpenAI, Gemini itp. w samej aplikacji. Konfiguracja operatora
(`models.local.json` + klucze w zmiennych środowiskowych, D-011…D-017) zostaje bez zmian; obok niej każdy dom ma
własnych dostawców, modele z cennikiem i kursy walut (`model_providers`, `household_models`, `household_fx`).

Źródła (sprawdzone 2026-09-26): Anthropic — Models API (`GET /v1/models`, nagłówki `x-api-key`
i `anthropic-version: 2023-06-01`, `limit` 1–1000; platform.claude.com/docs/en/api/models-list); OpenAI — lista
modeli `GET /v1/models` z `Authorization: Bearer` oraz `max_completion_tokens` zamiast przestarzałego `max_tokens`,
który nie działa z modelami rozumującymi (typy `CreateChatCompletionRequest` w openai-node; strona referencji
platform.openai.com odrzuca pobieranie automatyczne — 403); Gemini — warstwa zgodności z OpenAI
(ai.google.dev/gemini-api/docs/openai, aktualizacja 2026-09-02): adres
`https://generativelanguage.googleapis.com/v1beta/openai/`, klucz Gemini API jako Bearer, `/chat/completions`
i `/models`, wersja beta. **Nie sprawdzone na prawdziwych kontach** — testy wyłącznie na lokalnej atrapie, bez
płatnych wywołań.

- Uprawnienia: dostawców, klucze, modele i kursy zmienia tylko właściciel domu (`memberships.role = 'owner'`);
  domownik widzi stan (dostępność, ostatnie sprawdzenie, 4 ostatnie znaki klucza). Asystent nie ma narzędzi do
  zmiany tej konfiguracji.
- Klucz tylko do zapisu: AES-256-GCM kluczem `NOVA_SECRET_KEY` (ten sam sejf co tokeny OAuth, D-019), AAD
  `model_provider|<dom>|<dostawca>` — szyfrogram przeniesiony do innego rekordu nie daje się odszyfrować. API,
  audyt, zdarzenia i komunikaty walidacji nigdy nie zawierają klucza (audyt — nawet końcówki); ciała żądań nie są
  logowane. Rola aplikacji (`nova_app`) ma uprawnienie `SELECT` tylko do kolumn bez szyfrogramu; odczyt i zapis
  klucza — wyłącznie przez rolę systemową w kodzie serwera. Odszyfrowany klucz istnieje tylko w pamięci procesu API.
  Bez `NOVA_SECRET_KEY` klucza nie da się zapisać (czytelny błąd `no_vault`). `db:rotate-keys` szyfruje ponownie
  także klucze dostawców.
- Adres serwera: tylko `https://` bez loginu, hasła i parametrów; `http://localhost`/`127.0.0.1` (np. Ollama, także
  bez klucza) tylko przy `NOVA_MODELS_ALLOW_LOCAL` (domyślnie poza produkcją) — ogranicza SSRF przez właściciela
  domu. Wywołania dostawców nie podążają za przekierowaniami, a treść odpowiedzi błędów nie wraca do UI.
- Budżet działa bez zmian: model wymaga cennika (wejście/wyjście za milion tokenów, opcjonalnie cache) w walucie
  cennika; inna waluta niż budżetu wymaga kursu ustawionego przez właściciela (bez pobierania kursów z internetu),
  inaczej model jest niedostępny z powodem „brak kursu”. UI podaje link do oficjalnego cennika dostawcy i zapisuje
  źródło oraz datę sprawdzenia cennika (widoczne w `usage_records.price_source`). Koszt trafia do `usage_records`
  pod nazwą dostawcy, więc działa szacunek w „Usługi i koszty” (D-029).
- Routing: modele domu (wg priorytetu, zaznaczone „krótkie pytania” → `chat.simple`, „złożone zadania” →
  `chat.complex`) przed modelami z pliku; w trasach profili (Hermes) — na końcu, jako zapas, bo trasa profilu to
  świadomy wybór operatora. `dataPolicy` („tylko wspólne”) działa jak w pliku.
- **Ustawienia domu mają pierwszeństwo przed plikiem** (poprawka po zgłoszeniu: preset „Anthropic” kończył się
  błędem „nazwa zajęta”, bo domyślna konfiguracja z `models.example.json` ma dostawcę `anthropic`). Dostawca
  dodany w aplikacji o nazwie jak w pliku zastępuje go — tylko dla tego domu, także dla modeli z pliku, które go
  używają; wyłączony dostawca domu niczego nie zastępuje (wraca konfiguracja serwera). Model domu o nazwie jak
  w pliku (np. `claude-fast`) zastępuje go łącznie z miejscem w trasach. Inne domy i stan bez sesji — bez zmian.
  Uzasadnienie: właściciel domu świadomie ustawia to w aplikacji; wcześniejsza reguła „plik wygrywa” blokowała
  najprostszy scenariusz bez korzyści dla bezpieczeństwa (i tak wybiera on dostawców dla swojego domu).
- **Model w aplikacji na kluczu z `.env`** (migracja `0015`): model domu wskazuje dostawcę z aplikacji albo — po
  nazwie — dostawcę z pliku serwera (`server_provider`, dokładnie jedno z dwóch). Klucz zostaje wyłącznie
  w zmiennej środowiskowej; API pokazuje tylko nazwę zmiennej i to, czy klucz wczytano. Częsty przypadek: klucz
  w `.env` działa, ale model z przykładowego pliku nie ma cennika — strona pokazuje „brak cennika” i przycisk
  „Uzupełnij cennik”, który otwiera formularz z dostawcą, nazwą i identyfikatorem modelu z pliku. Waluty bez
  kursu (także modeli z pliku) trafiają do „Kursy walut”.
- Bez restartu: `ModelGateway.snapshot(dom)` łączy plik i dane domu (pamięć podręczna 30 s, unieważniana po każdej
  zmianie w tym procesie; inne instancje API widzą zmianę najpóźniej po 30 s). `AutoAgentRuntime` wybiera w każdej
  turze model albo jawny tryb demo — usunięcie ostatniego dostawcy przywraca demo. `/api/model/status`
  i `/api/health` (z sesją) pokazują stan domu; `/api/health` bez sesji — tylko konfigurację z pliku.
- „Sprawdź klucz”: bezpłatna lista modeli (Anthropic `GET {base}/v1/models?limit=1000`, zgodni z OpenAI
  `GET {base}/models`), limit 10 sprawdzeń na minutę na osobę, wynik zapisany przy dostawcy; zwrócone
  identyfikatory są podpowiedziami w formularzu modelu. Zmiana klucza lub adresu kasuje poprzedni wynik.
- Oficjalne API OpenAI (`api.openai.com`) dostaje `max_completion_tokens`; pozostałe serwery zgodne z OpenAI
  (Hermes, Gemini, Ollama) — `max_tokens`.
- Poza zakresem: automatyczne pobieranie cenników (brak oficjalnego, maszynowego źródła cen), osobni dostawcy per
  domownik, natywne API Gemini, Vertex AI / Bedrock, strumieniowanie.
- Gałąź bazowa: `claude/novaai-services-costs` (zawiera pamięć dokumentów, Microsoft, Slack i „Usługi i koszty”).

## D-031 Dokumenty w rozmowie z modelem: lista dokumentów i narzędzia odczytu

Zgłoszenie: z prawdziwym modelem pytanie „co ciekawego jest w moim cv” (PDF po angielsku, status „gotowy”) dało
odpowiedź „nie mam dostępu do dokumentów”. Przyczyna: automatyczny dobór fragmentów (D-025) szuka po słowach
pytania — „cv” (2 litery) jest pomijane, a „ciekawego” nie występuje w angielskim CV, więc do modelu nie trafił
żaden fragment; model nie wiedział też, jakie dokumenty istnieją, i nie miał narzędzia, żeby je otworzyć.
Wyszukiwanie po słowach nie obsłuży pytań o cały dokument („streść”, „co ciekawego”) ani pytań w innym języku
niż dokument.

- Lista dokumentów: w każdej turze model dostaje blok DOKUMENTY — dokumenty dozwolone w tym kontekście (ta sama
  funkcja co dla fragmentów: RLS zakresu + polityka `document.read`; NovaAI — tylko wspólne), najwyżej 30, tylko
  id, tytuł, plik, liczba stron i fragmentów. Tytuły pochodzą od użytkowników, więc blok jest w wiadomości
  użytkownika jako oznaczone dane, nie w prompcie systemowym.
- Narzędzia `documents.read` (dokument po kolei, do 12 fragmentów na wywołanie, z przesunięciem) i
  `documents.search` (słowa w języku dokumentu, opcjonalnie w jednym dokumencie): tylko odczyt, bez zgody,
  udostępniane modelowi wyłącznie wtedy, gdy lista dokumentów nie jest pusta. Autoryzacja przy planowaniu,
  wykonaniu i ponownie przy pobraniu treści; cudzy lub niewspólny dokument ⇒ odmowa `document_not_available`
  (bez rozróżnienia „nie istnieje” / „brak dostępu”), także gdy model poda prawdziwe id.
- Treść na żywo, bez zapisu (jak Slack, D-028): w rozmowie zapisuje się tylko „Dokument „X”: fragmenty 1–3 z 3”;
  treść trafia do modelu w turze uzupełniającej (D-023) jako WYNIK NARZĘDZIA (dane), limit ok. 24 tys. znaków.
  Usunięcie dokumentu lub cofnięcie udostępnienia działa od razu — treść nie zostaje w historii rozmowy.
- Prompt systemowy: gdy pytanie dotyczy dokumentu z listy (także nazwanego inaczej lub w innym języku), a
  fragmentów brak lub nie wystarczają — zaproponuj `documents.read`/`documents.search` zamiast odpowiadać, że nie
  ma dostępu. Niezaufany kontekst nadal wymusza zgodę na akcje ze skutkami (D-026); narzędzia dokumentów są
  tylko do odczytu.
- Automatyczny dobór fragmentów zostaje (tani, ze źródłami [D1]); narzędzia działają, gdy nie wystarcza.
- Sprawdzone wyłącznie z atrapą dostawcy (co serwer wysyła do modelu i co robi z propozycją narzędzia) — nie
  jakość decyzji prawdziwego modelu, czy użyje narzędzia.

## D-032 Odpowiedź na żywo (strumieniowanie) bez zapisu fragmentów

- Dostawca Anthropic strumieniuje odpowiedź przez SDK (`client.messages.stream`, zdarzenie `text`), a wynik
  (narzędzia, `usage`, powód zakończenia) pochodzi z `finalMessage()` — budżet i narzędzia działają bez zmian.
  Sprawdzone testem kontraktowym na atrapie zdarzeń strumienia Messages API (message_start → bloki →
  message_delta → message_stop). Dostawcy zgodni z OpenAI (OpenAI, Gemini, Hermes, Ollama) na razie bez
  strumieniowania — odpowiedź pojawia się w całości z animacją odsłaniania.
- Fragmenty idą ulotnym zdarzeniem SSE `message.delta` (bez `id`, bez zapisu w tabeli zdarzeń) z procesu, który
  wykonuje turę — w tym samym procesie co strumień SSE (jedna instancja, D-024). Odbiorcy jak dla rozmowy:
  prywatna — tylko właściciel, wspólna — aktywni członkowie domu; widoczność sprawdzana przy każdym fragmencie
  z uprawnieniami odświeżanymi razem z sesją. Pełna odpowiedź zawsze przychodzi zwykłym `message.created`.
- Fragmenty łączone co ~50 ms; każdy niesie przesunięcie i numer próby (kolejny model po błędzie zaczyna tekst
  od nowa). Klient dokleja tylko fragmenty ciągłe; zgubiony fragment nie psuje odpowiedzi, bo na końcu zastępuje
  ją zapisana wiadomość (bez ponownej animacji). Czytnik ekranu dostaje pełną odpowiedź po zapisaniu.

## D-033 Głos ElevenLabs po stronie serwera

Prośba: odczyt głosem ElevenLabs, głos `o2xdfKUpc1Bwq7RchZuW`, klucz w `.env`. Dokumentacja (sprawdzona 2026-09-26):
`POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}`, nagłówek `xi-api-key`, ciało `{ text, model_id }`,
`output_format` (domyślnie `mp3_44100_128`), błąd walidacji 422; modele: `eleven_flash_v2_5` (polski, ~75 ms,
o połowę tańszy znak w API), `eleven_multilingual_v2` (polski, wyższa jakość, domyślny w API). **Nie sprawdzone
na prawdziwym koncie** — testy na lokalnej atrapie.

- Klucz tylko na serwerze (`ELEVENLABS_API_KEY`); głos i model w `.env` (`ELEVENLABS_VOICE_ID`, domyślnie podany
  głos; `ELEVENLABS_MODEL_ID`, domyślnie `eleven_flash_v2_5` — rozmowa głosowa potrzebuje małego opóźnienia).
- Serwer czyta wyłącznie to, co użytkownik widzi: odpowiedź asystenta z dostępnej rozmowy (po id, przez RLS) albo
  własny przegląd dnia — `POST /api/tts` nie przyjmuje dowolnego tekstu, więc nie jest otwartym pośrednikiem
  płatnego API. Tekst bez odnośników [D1] i znaczników, najwyżej ok. 2500 znaków (koniec zdania + „Dalsza część
  jest w czacie”).
- Koszt: miesięczny limit znaków na dom (`ELEVENLABS_MONTHLY_CHARS`, domyślnie 30 000; tabela `tts_usage` tylko
  z liczbą znaków), pamięć podręczna ostatnich 30 odczytów (ponowny odczyt bez kosztu), 30 odczytów na minutę na
  osobę. Audyt `tts.synthesize` z liczbą znaków, bez treści i klucza; błędy dostawcy bez treści odpowiedzi.
- Przeglądarka: jeden odtwarzacz mowy; bez klucza, po przekroczeniu limitu, błędzie sieci lub odtwarzania — głos
  przeglądarki. CSP: `media-src 'self' blob:` (dźwięk z odpowiedzi API). Ustawienia pokazują dostawcę głosu,
  głos, model i zużycie znaków w miesiącu.

## D-034 Rozpoznawanie mowy: przeglądarka, a w zapasie ElevenLabs przez serwer

Zgłoszenie: „Rozmowa głosowa” i dyktowanie kończyły się ogólnym „Błąd rozpoznawania mowy”. Każdy kod błędu Web
Speech API poza `not-allowed` dawał ten sam komunikat. Najczęstsza przyczyna na `localhost`: przeglądarka ma
`webkitSpeechRecognition`, ale bez usługi rozpoznawania (Brave, Opera, Vivaldi, Chromium bez usług Google) —
błąd `network`; Firefox nie ma API wcale. Kody wg MDN `SpeechRecognitionErrorEvent.error` (sprawdzone 2026-09-26).

- Każdy kod ma konkretny komunikat z tym, co zrobić (zgoda na mikrofon, mikrofon zajęty lub zablokowany w Windows,
  przeglądarka bez usługi, brak polskiego…), widoczny nad polem wiadomości — nie tylko w podpowiedzi przycisku.
- Zapas: po `network`, `service-not-allowed` albo `language-not-supported` (mikrofon działa, zawiodła usługa) —
  albo gdy przeglądarka nie ma API — nagranie z mikrofonu (MediaRecorder) rozpoznawane przez serwer w ElevenLabs,
  bez ponownego klikania; do końca sesji karty od razu przez serwer. Koniec wypowiedzi wykrywany po poziomie dźwięku
  (1,2 s ciszy; najwyżej 30 s; bez mowy przez 8 s — „nic nie słychać”), żeby nie płacić za ciszę.
- Dokumentacja ElevenLabs (sprawdzona 2026-09-26): `POST https://api.elevenlabs.io/v1/speech-to-text`,
  `multipart/form-data` z `file` i `model_id` (`scribe_v2`; `scribe_v1` przestarzały), opcjonalnie
  `language_code` (wysyłamy `pol`); odpowiedź `{ text, words, audio_duration_secs, … }`; rozliczenie za długość
  nagrania. **Nie sprawdzone na prawdziwym koncie** — testy na lokalnej atrapie.
- `POST /api/stt`: surowe bajty `audio/webm|ogg|mp4|mpeg|wav|aac` (0,5 KB – 3 MB), tylko zalogowany członek domu,
  CSRF, 20 nagrań na minutę na osobę, miesięczny limit minut na dom (`ELEVENLABS_STT_MONTHLY_MINUTES`, domyślnie
  60; 0 wyłącza). Zużycie z `audio_duration_secs` (bez niego liczymy 30 s) w `stt_usage` — bez treści. Nagranie
  i tekst nie są zapisywane; audyt `stt.transcribe` z liczbą bajtów i sekund, bez treści i klucza; błędy dostawcy
  bez treści odpowiedzi.
- Osobna, jednorazowa zgoda na wysyłanie nagrań do ElevenLabs (inna niż zgoda na usługę przeglądarki).
  Ustawienia pokazują model i zużycie minut w miesiącu.

## D-035 Plan zajęć i inne kalendarze z pliku .ics; data i godzina dla modelu

Prośba: wgrywanie planu zajęć z Wirtualnego Dziekanatu (IDEIS, WSEI Kraków). Strona ma eksport „Zapisz jako
ical”, ale zakres dat bierze z sesji przeglądarki ustawionej przyciskiem „Szukaj” (parametry w adresie są
pomijane, a odtworzenie wywołania strony serwer odrzuca) — automatyczne pobieranie z serwera NovaAI byłoby
kruche, więc właściciel pobiera plik sam i wgrywa go w Ustawienia → Kalendarz. Konto uczelniane Microsoft 365
zwykle wymaga zgody administratora na dostęp do poczty i kalendarza (zasady zgody Entra), więc nie jest drogą
do planu.

- Odczyt pliku: `ical.js` (Mozilla, MPL-2.0, bez zależności). Powtarzanie (RRULE, EXDATE, RECURRENCE-ID)
  rozwijane w oknie od 31 dni wstecz do 400 dni naprzód, najwyżej 3000 wydarzeń, odwołane (STATUS:CANCELLED)
  pomijane. Czas ze strefą bez definicji w pliku (tak eksportuje ical.net w IDEIS) i czas „pływający” liczony
  w podanej strefie IANA, a gdy jej brak lub nie jest znana (np. nazwa z Windows) — w Europe/Warsaw; cały dzień
  od północy w Polsce. Tekst bez znaków sterujących, przycięty (tytuł, miejsce 200, opis 500 znaków).
- IDEIS nie wypełnia LOCATION — sala jest w opisie („Sala: …”, razem z „Prowadzący”, „Grupy” itd.). Opis
  w liniach „Klucz: wartość”: sala (także „Miejsce”) trafia do miejsca, gdy LOCATION puste; reszta zwięźle
  („Grupy: Konw; Prowadzący: …”) bez pól powtarzających tytuł i czas oraz pustych. Opis bez takich linii bez
  zmian. Asystent dostaje te szczegóły (do 200 znaków na wydarzenie) razem z salą, oznaczoną „sala/miejsce”.
- Plan toku obejmuje wszystkie grupy — właściciel odznacza przedmioty, których nie ma (lista tytułów w imporcie,
  `excluded_titles`; wydarzenia `hidden`). Ukryte nie trafiają do przeglądu dnia, zajętości ani do asystenta;
  wybór obowiązuje też dla nowej wersji pliku. Nowe przedmioty w nowej wersji są domyślnie pokazywane.
- IDEIS nie wypełnia LOCATION — sala jest w opisie („Sala: …”, razem z „Prowadzący”, „Grupy” itd.). Opis
  w liniach „Klucz: wartość”: sala (także „Miejsce”) trafia do miejsca, gdy LOCATION puste; reszta zwięźle
  („Grupy: Konw; Prowadzący: …”) bez pól powtarzających tytuł i czas oraz pustych. Opis bez takich linii bez
  zmian. Asystent dostaje te szczegóły (do 200 znaków na wydarzenie) razem z salą.
- Dane: `calendar_imports` + wydarzenia w `local_calendar_events` (kolumny `import_id`, `location`, `notes`) —
  RLS tylko właściciel (migracja 0018). Plik nie jest przechowywany. Nowa wersja pliku zastępuje wszystkie
  wydarzenia importu w jednej transakcji; usunięcie importu usuwa jego wydarzenia. Audyt z liczbą wydarzeń,
  bez tytułów. Pusty plan => czytelna instrukcja („wybierz zakres dat, Szukaj, Zapisz jako ical”).
- Użycie: przegląd dnia (z salą, także w tekście czytanym na głos), zajętość (jak kalendarz lokalny) i nowe
  narzędzie `calendar.agenda` — tylko agent prywatny, tylko odczyt, wynik prywatny, bez połączonego konta;
  tytuły i sale to dane z pliku (niezaufane), nie polecenia. NovaAI (wspólny) go nie dostaje.
- Model dostaje bieżącą datę i godzinę w Polsce w instrukcjach — wcześniej nie znał dnia, więc „jutro” czy
  „w piątek” było zgadywaniem.
