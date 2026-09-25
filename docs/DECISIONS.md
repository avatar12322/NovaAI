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

## D-007 Sesje i logowanie

- Sesje serwerowe: losowy token 256-bit w ciasteczku `HttpOnly; SameSite=Strict` (`Secure` w produkcji);
  w bazie tylko SHA-256 tokenu. Sesja jest związana ze środowiskiem (`env`).
- CSRF: każda mutacja pod `/api/` wymaga nagłówka `x-nova-csrf: 1` + kontrola `Origin`.
- Logowanie testowe (2 sztuczne konta `alfa@example.test`, `beta@example.test`, dom „Dom testowy”):
  trasa rejestrowana tylko gdy `NOVA_ENV ∈ {development,test}` i `NOVA_DEV_LOGIN=true`.
  `NOVA_DEV_LOGIN=true` przy `NOVA_ENV=production` zatrzymuje start (test w `health.test.ts`).
  Sesje `dev` i konta fixture są odrzucane w produkcji nawet przy istniejącym ciasteczku.
- Docelowo passkeys/WebAuthn (`@simplewebauthn/server`). **Fallback wdrożeniowy** (do czasu passkeys):
  jednorazowy link logowania generowany lokalnie przez administratora CLI — do zaprojektowania w M-auth;
  w tej sesji niewdrożone (patrz PROGRESS → blokady).

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
  + `NOVA_SECRET_KEYS_OLD`, potem `pnpm --filter @nova/api db:rotate-keys`. Rola `nova_app` nie ma prawa odczytu
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
- Microsoft 365 i Slack (OAuth): oznaczone jako niezaimplementowane; Google Pub/Sub push (JWT OIDC) i odnawianie
  subskrypcji (watch/Graph) — nie zaimplementowano.
