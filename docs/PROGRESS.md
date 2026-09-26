# Postęp prac NovaAI

Aktualizowane po każdej pionowej funkcji. Tylko fakty potwierdzone poleceniami w tej sesji.

## Status etapów

| Etap                     | Status    | Uwagi                                                                                                                     |
| ------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------- |
| M0 — szkielet            | gotowe    | workspace, API, web, Postgres lokalny, migracje, healthcheck; Compose nieprzetestowany (brak Dockera)                     |
| M1 — izolacja            | gotowe    | sesje, polityka + RLS, rozmowy, pamięć, udostępnianie, audyt; testy izolacji Alfa/Beta                                    |
| M2 — UI i zadania        | gotowe    | trwała kolejka, zgody, SSE, UI desktop/telefon, PWA; e2e                                                                  |
| M3 — model i pamięć      | częściowe | brama modeli, budżet, broker, wyniki narzędzi → model; adaptery Anthropic/Hermes tylko na mockach (brak kluczy)           |
| M4 — Worker              | częściowe | protokół, symulator, Worker Rust (Linux + interop z API); na Windows tylko kompilacja, bez uruchomienia                   |
| M5 — integracje          | częściowe | Google (kalendarz free/busy, Gmail) na mockach, Slack webhook; brak kont OAuth; Microsoft/Slack OAuth niezaimplementowane |
| M6 — głos i proaktywność | częściowe | przypomnienia, powiadomienia w aplikacji, dyktowanie/odczyt w przeglądarce; brak Web Push i transkrypcji serwerowej       |
| Passkeys + bootstrap     | gotowe    | WebAuthn (testy API z programowym uwierzytelniaczem, e2e z wirtualnym Chromium), CLI admin                                |
| Utwardzenie              | gotowe    | limity tras bez sesji, redakcja URL w logach, `NOVA_TRUST_PROXY`, sprzątanie wygasłych artefaktów                         |
| Ścieżka produkcyjna      | częściowe | bundel API + frontend z API + CSP, smoke w `NOVA_ENV=production`; bez realnego serwera, TLS i domeny                      |
| Pamięć dokumentów        | gotowe*   | PDF/TXT/Markdown, indeksowanie, wyszukiwanie po uprawnieniach, źródła w odpowiedzi, UI; *model tylko jako atrapa          |

## Dziennik

### M0 (2026-09-25)

- Rozpoznanie: repo puste; Node 22.22, pnpm 10.33, PostgreSQL 16.13 (bez demona Docker), Rust 1.94.
- Utworzono szkielet wg sekcji 2 specyfikacji; decyzje D-001…D-010.
- Polecenia i wyniki:
  - `pnpm db:start` → klaster w `.data/pg`, port 54329, role `nova_owner`/`nova_app`, bazy `nova_dev`/`nova_test`.
  - `pnpm typecheck` → 5/5 pakietów bez błędów.
  - `pnpm lint` → 0 problemów; `pnpm format:check` → OK.
  - `pnpm test` → contracts 4/4, permissions 22/22, api 5/5 (health, request-id, 404, blokada dev-login w produkcji).
  - `pnpm db:seed` + `pnpm dev:api` + `curl /api/health` → `{"status":"ok","db":"ok","migrations":{"applied":2,"pending":0}}`.
  - `pnpm --filter @nova/web build` → OK.

### M1 (2026-09-25)

- API: `GET/POST /api/conversations`, `GET /api/conversations/:id`, `GET/POST /api/conversations/:id/messages`,
  `GET/POST /api/memories`, `PATCH/DELETE /api/memories/:id`, `POST /api/memories/:id/share|unshare`,
  `GET /api/me`, `POST /api/auth/dev-login|logout`, `GET /api/auth/dev-users`.
- Kontekst agenta (`apps/api/src/agent/context.ts`): zakres RLS z kontekstu (NovaAI ⇒ `shared`),
  każdy rekord ponownie sprawdzany `decide()`; rozbieżność ⇒ audyt `agent.context.policy_mismatch`.
- `FakeAgentRuntime` (deterministyczny, jawny tryb demo) odpowiada synchronicznie (w M2 — przez kolejkę).
- Poprawka znaleziona testem: trigger spójności agent↔rozmowa działał pod RLS → migracja `0003` (SECURITY DEFINER).
- `pnpm test` → contracts 4/4, permissions 22/22, api 30/30 (`isolation.test.ts`: 401/CSRF/Origin, Alfa↛Beta,
  Beta↛Alfa, shared dla obojga, udostępnienie/cofnięcie natychmiastowe + audyt, ignorowanie `ownerUserId`,
  pamięć `shared` bez grantu niewidoczna, konteksty agentów, odebranie członkostwa, RLS bez `WHERE`,
  `scope=shared`, brak kontekstu ⇒ 0 wierszy, RLS blokuje INSERT/UPDATE/DELETE cudzych, brak dostępu do sesji/audytu).

### M2 (2026-09-25)

- Kolejka (`apps/api/src/queue/runner.ts`): claim SKIP LOCKED, lease/heartbeat, odzysk, backoff, kroki z
  zależnościami; rodzaje zadań `agent.turn` (tura czatu) i `demo.workflow` (jawne demo, bez modelu).
- Zgody (`modules/approvals.ts`, `queue/approvals.ts`): zamrożona akcja + skrót, atomowe rozstrzygnięcie,
  unieważnienie po zmianie parametrów, wygaśnięcie, idempotentne wykonanie.
- Broker narzędzi (`tools/broker.ts`) + narzędzia `memory.create`, `household.notify` (zawsze ze zgodą).
- API: `GET/POST /api/tasks`, `GET /api/tasks/:id`, `GET /api/tasks/:id/steps`, `POST /api/tasks/:id/cancel`,
  `GET /api/approvals`, `GET /api/approvals/:id`, `POST /api/approvals/:id/approve|reject`,
  `GET /api/events` (polling), `GET /api/events/stream` (SSE), `GET /api/notifications`, `POST /api/notifications/:id/read`.
- UI (`apps/web`): logowanie testowe, czat prywatny i NovaAI, Zadania z krokami i postępem, Approval Center,
  Pamięć z `Udostępnij`, Dom, Ustawienia (stan usług, motyw), Activity Strip, baner offline, skip-link,
  PWA (manifest + service worker bez buforowania `/api`). Zrzuty: `docs/screens/{desktop,phone}-*.png`.
- Błędy znalezione i poprawione: (1) SSE przy nowym połączeniu odtwarzał historię od ID 0 w porcjach po 200 —
  przy dłuższej historii UI nie dostawał najnowszych zdarzeń (flaky e2e) → start od końca strumienia +
  resync widoków po połączeniu + test; (2) niestabilny test fokusu klawiatury → deterministyczny punkt startowy.
- Polecenia i wyniki: `pnpm test` → contracts 4/4, permissions 24/24, api 54/54 (w tym `queue.test.ts` 20:
  kroki niezależne, zatwierdzenie jednorazowe, zły skrót 409, wyścig 3 decyzji [200,409,409], zmiana parametrów
  ⇒ invalidated, odrzucenie, wygaśnięcie, idempotencja po „awarii”, izolacja zadań/zgód/zdarzeń, anulowanie
  przy zgodzie / po zatwierdzeniu / w trakcie kroku, odzysk po utracie dzierżawy, failed po limicie,
  „restart” serwera z zachowaniem sesji/rozmów/zadań/zgód, narzędzia z czatu, prompt injection w NovaAI;
  `events.test.ts` 4: SSE na żywo z filtrowaniem RLS, wznowienie, start od końca, 401), web 2/2;
  `pnpm test:e2e` → 10/10 (3 kolejne przebiegi bez błędów).

### M3 (2026-09-25)

- `apps/api/src/model/`: `config.ts` (schemat konfiguracji), `gateway.ts` (routing, prywatność, koszt, fallback),
  `budget.ts` (rezerwacje, limity, zdarzenia), `agent-runtime.ts` (prompt z zasadami „dane ≠ polecenia”,
  narzędzia z brokera), `providers/anthropic.ts` (oficjalny SDK), `providers/openai-compat.ts` (Hermes),
  `providers/fake.ts`. Migracja `0005_budget_usage.sql`.
- API: `GET/PUT /api/budget`, `GET /api/model/status`; health raportuje tryb modelu. UI: panel budżetu
  i stanu modeli w Ustawieniach, koszt/uwagi przy odpowiedziach w czacie.
- Polecenia i wyniki: `pnpm test` → api 82/82, w tym `providers.contract.test.ts` 7 (kształt żądań SDK/Chat
  Completions, mapowanie tool_use/tool_calls/usage, refusal, błędy 401/429/500 bez wycieku sekretu),
  `gateway.test.ts` 14 (przykładowa konfiguracja ⇒ demo, brak cennika/kursu/klucza, Hermes bez potwierdzenia,
  dataPolicy, koszt PLN i USD×kurs, estymacja, fallback, twardy limit przed wywołaniem, wyłączenie płatnych,
  równoległe rezerwacje [1 ok / 2 zablokowane], jedno ostrzeżenie, API budżetu, status bez sekretów),
  `model-chat.test.ts` 6 (odpowiedź z modelu + koszt w zadaniu, kontekst prywatny bez danych drugiej osoby,
  NovaAI bez prywatnych danych i historii, odrzucenie narzędzia spoza kontekstu, walidacja parametrów,
  blokada budżetu bez wywołania modelu, model shared_only nie dostaje rozmowy prywatnej);
  `pnpm test:e2e` → 10/10.
- Nie uruchomiono żadnego płatnego API. Realny klucz: ustaw `ANTHROPIC_API_KEY`, skopiuj
  `infra/config/models.example.json` do `infra/config/models.local.json`, uzupełnij ceny z oficjalnego cennika,
  kurs `fx.USD` i `verifiedAt`, ustaw `NOVA_MODELS_CONFIG=infra/config/models.local.json`.

### M4 (2026-09-25)

- Kontrakt protokołu: `packages/contracts/src/worker.ts`; migracja `0006_devices.sql` (devices, pairing codes,
  device_grants, device_commands, RLS tylko dla właściciela).
- API: `apps/api/src/devices/` — `keys.ts` (Ed25519, HKDF, kody), `paths.ts` (walidacja leksykalna Windows/POSIX),
  `hub.ts` (połączenia, podpisy, oczekujące polecenia), `broker.ts` (autoryzacja przed wysyłką, dziennik, audyt),
  `tools.ts` (list/read/write/git jako narzędzia brokera; zapis ze zgodą i diffem), `routes.ts`
  (`GET /api/devices`, `POST /api/devices/pairing-codes`, `POST|DELETE /api/devices/:id/grants[/:grantId]`,
  `POST /api/devices/:id/revoke`, `POST /api/device-link/pair`, WS `/api/device-link/connect`), `simulator.ts`.
- Worker Rust (`workers/windows`): `protocol.rs`, `policy.rs`, `fsops.rs`, `git.rs`, `state.rs`, `executor.rs`,
  `client.rs`, CLI `pair | run | check`; README z instrukcją testu ręcznego na Windows.
- UI: Ustawienia → Urządzenia (kod parowania z instrukcją, status online na żywo, granty, cofanie, odłączanie).
  Czat demo: `pliki: <ścieżka>`, `przeczytaj: <ścieżka>`, `git status: <repo>`, `zapisz <ścieżka>: <treść>`.
- Polecenia i wyniki:
  - `pnpm test` → api 108/108, w tym `devices.test.ts` 16 (parowanie, kod jednorazowy, wygasły kod, limiter 429,
    hello obcym kluczem ⇒ 4401, odłączenie ⇒ 4403 i brak ponownego połączenia, cudze urządzenie odrzucone przed
    wysyłką, brak grantu, ścieżka poza grantem, `..`, cofnięcie grantu i urządzenia przed kolejnym poleceniem,
    symlink pliku i katalogu poza korzeń odrzucony przez Workera, zdolność spoza lokalnej polityki, katalog spoza
    lokalnych korzeni, polecenie z obcym podpisem, termin miniony, zapis ze zgodą + diff + kopia + brak plików tmp,
    `base_changed`, idempotentny zapis, wynik w rozmowie, NovaAI bez narzędzi urządzeń, git status/diff),
    `paths.test.ts` 5, `rust-worker.test.ts` 5 (prawdziwa binarka Rust ↔ API: parowanie, podpisy, lista/odczyt,
    symlink, zapis z kopią i `base_changed`, odłączenie kończy proces).
  - `pnpm worker:test` → `cargo fmt --check` OK, `cargo clippy -D warnings` OK, `cargo test` 18/18.
  - `pnpm worker:check-windows` → `cargo check --target x86_64-pc-windows-gnu` OK (kod `cfg(windows)` kompiluje się),
    clippy dla targetu Windows OK. **Nie uruchomiono na Windows** (brak systemu) — w tym test junction.
  - `pnpm test:e2e` → 12/12 (dodany `devices.spec.ts`: kod z UI → symulator → grant z formularza → `pliki:` w czacie → odłączenie).

### M5 (2026-09-25)

- `apps/api/src/connectors/`: `types.ts`, `vault.ts`, `google.ts`, `service.ts`, `tools.ts` (calendar.freebusy,
  mail.search/read/send), `routes.ts` (`GET /api/connections`, `POST /api/connections/:provider/start`,
  `GET /api/connections/:provider/callback`, `DELETE /api/connections/:provider`,
  `GET|POST|DELETE /api/calendar/freebusy-grant`, `GET|POST /api/calendar/local-events`, `DELETE /api/calendar/local-events/:id`,
  `POST /api/webhooks/slack`). Migracja `0007_connections.sql`. CLI `db:rotate-keys`.
- UI: Ustawienia → Integracje (status/łączenie/odłączanie), Kalendarz (grant free/busy dla NovaAI, kalendarz lokalny).
  Czat demo: `zajętość: <od> <do>`, `szukaj maili: …`, `przeczytaj maila: <id>`, `wyślij mail do <adres>: <temat> | <treść>`.
- Polecenia i wyniki: `pnpm test` → api 127/127, w tym `vault.test.ts` 5 (szyfrowanie, AAD, modyfikacja, rotacja,
  długość klucza) i `connectors.test.ts` 14 (not configured z powodem, URL autoryzacji z minimalnym zakresem i PKCE,
  wymiana kodu z weryfikatorem, tokeny zaszyfrowane i niedostępne dla roli aplikacji, izolacja Alfa/Beta, audyt bez
  tokenów, jednorazowy state, odmowa użytkownika, odświeżanie, invalid_grant ⇒ reauth, odwołanie, rotacja,
  free/busy bez grantu/z grantem/po cofnięciu bez tytułów, źródło Google, mail ze zgodą i RFC 2822, brak ponowienia
  przy nieznanym wyniku, NovaAI bez poczty, „instrukcje” w mailu bez efektów, header injection, webhook Slack:
  podpis, okno czasowe, challenge, deduplikacja); web 3/3; `pnpm test:e2e` → 12/12.

### M6 (2026-09-25)

- `apps/api/src/reminders/` (`service.ts`, `routes.ts`, `tool.ts`), migracja `0008_reminders.sql`;
  API `GET /api/reminders?space=`, `POST /api/reminders`, `DELETE /api/reminders/:id`; narzędzie `reminder.create`;
  czat demo: `przypomnij mi za 10 minut: …`, `przypomnij nam za 2 godz: …` (NovaAI ⇒ wspólne).
- UI: „Dom” → Przypomnienia (dodawanie, anulowanie, status „dostarczone”); czat: przycisk dyktowania (opt-in)
  i odczytu odpowiedzi.
- Znaleziony i poprawiony błąd UI: automatyczne otwarcie ostatniej rozmowy na desktopie mogło nadpisać
  nawigację wykonaną w trakcie ładowania listy (źródło sporadycznych błędów e2e) — teraz tylko gdy trasa
  nadal wskazuje listę, przez `location.replace`.
- Polecenia i wyniki: `pnpm test` → api 136/136 (w tym `reminders.test.ts` 9: prywatne tylko do właściciela,
  wspólne do obojga, anulowanie i brak anulowania cudzego, działanie przy zablokowanym budżecie bez `usage_records`,
  odebrane członkostwo ⇒ brak dostarczenia, restart kolejki, brak duplikatów, walidacja terminu, komendy z czatu);
  `pnpm test:e2e` → 14/14 w 3 kolejnych przebiegach (dodany `reminders.spec.ts`).

### Passkeys i bootstrap produkcji (2026-09-26)

- `apps/api/src/auth/passkeys.ts` (rejestracja, logowanie, lista/usuwanie, enrolment z linku),
  `apps/api/src/db/admin.ts` + CLI `admin create-household|enroll|disable-user`, migracja `0009_passkeys.sql`,
  `GET /api/auth/config`. UI: „Zaloguj kluczem dostępu”, widok `#/enroll/<token>`, klucze w Ustawieniach.
- Polecenia i wyniki: `pnpm test` → api 142/142 (w tym `passkeys.test.ts` 6: rejestracja + logowanie z sesją
  `passkey`, powtórka odpowiedzi i wyzwania, zły origin przy rejestracji i logowaniu, brak UV, cofnięty licznik,
  nieznany klucz, cudzy klucz, link z CLI: jednorazowy i wygasający, nowy dom z agentami, konfiguracja RP w produkcji);
  `pnpm test:e2e` → 18/18 (dodany `passkeys.spec.ts` z wirtualnym uwierzytelniaczem Chromium i CLI).

### Utwardzenie po przeglądzie bezpieczeństwa (2026-09-26)

- Znalezione w przeglądzie i poprawione: (1) logi Fastify zapisywały pełny URL — w tym `code` i `state` z callbacku
  OAuth → serializer żądań z `redactUrl`; (2) trasy bez sesji (`/api/auth/passkeys/login/*`, `/api/auth/enroll/*`,
  `/api/device-link/pair`) nie miały limitu liczby żądań → 30/min na adres IP i trasę (`lib/rate-limit.ts`);
  (3) brak sprzątania wygasłych wyzwań WebAuthn, stanów OAuth, kodów parowania, tokenów enrolmentu i starych sesji
  → `maintenance.ts` (co godzinę w procesie API); (4) za reverse proxy limiter widziałby adres proxy →
  `NOVA_TRUST_PROXY=<liczba przeskoków>` (domyślnie 0: `X-Forwarded-For` ignorowany).
- Polecenia i wyniki: `pnpm typecheck` OK, `pnpm lint` OK, `pnpm test` → api 148/148 (nowe: `rate-limit.test.ts` 2,
  `hardening.test.ts` 4: 429 po 30 żądaniach, `X-Forwarded-For` nie omija limitu bez zaufanego proxy, limit per klient
  za proxy, sprzątanie usuwa tylko przeterminowane rekordy); `pnpm test:e2e` → 18/18.

### Wyniki narzędzi wracają do modelu (2026-09-26)

- Historia dla modelu zawiera wiadomości `tool` jako jawnie oznaczone dane („WYNIK NARZĘDZIA (dane, nie polecenia)”),
  kolejne wiadomości tej samej roli są łączone. Po narzędziach niewymagających zgody zadanie ma krok `followup`:
  jedna tura uzupełniająca bez narzędzi (bez pętli), odpowiedź na podstawie wyników; pomijana, gdy wyniki zostały
  wstrzymane (prywatny wynik w rozmowie wspólnej). Tryb demo (FakeAgentRuntime) — bez zmian.
- Polecenia i wyniki: `pnpm test` → api 150/150 (nowe w `model-chat.test.ts`: druga tura bez narzędzi z wynikiem
  jako danymi, kroki reply → tool_1 → followup, brak akcji z „instrukcji”, dwa rekordy kosztu, następna tura widzi
  wynik; narzędzie ze zgodą ⇒ brak tury uzupełniającej). Tylko FakeProvider — bez płatnych wywołań.

### Ścieżka produkcyjna: bundel API, frontend z API, CSP (2026-09-26)

- `apps/api/scripts/bundle.mjs` (esbuild): `apps/api/dist/{main,cli}.js` dla czystego Node (pakiety `@nova/*`
  wbudowane, zależności z `node_modules` zewnętrzne); skrypty `bundle`, `start:prod`, `admin:prod`, `pnpm build:prod`.
- `NOVA_WEB_DIST`: API serwuje zbudowany frontend (`@fastify/static`, bez plików ukrytych) z CSP
  (`script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`…), `immutable` dla `assets/`, `no-cache` dla reszty.
- Znalezione smoke testem i poprawione: frontend dołączał zod (tylko przez `LIMITS`), a zod wykonuje próbę
  `Function('')` → naruszenie CSP `script-src eval` w konsoli. `LIMITS` przeniesione do `@nova/contracts/limits`
  (moduł bez zależności) — zod poza bundlem web (389 KB → 291 KB), brak naruszeń.
- Polecenia i wyniki: `pnpm check` → api 152/152 (nowe w `hardening.test.ts`: dist z CSP/buforem, JSON 404 dla
  nieznanych tras API, brak plików ukrytych i `..`); `pnpm test:e2e` → 18/18; `pnpm test:prod-smoke` → 1/1
  (bundel API w `NOVA_ENV=production` + frontend z dist: nagłówki, brak logowania testowego, konto z CLI bundla,
  passkey, czat przez kolejkę i SSE, ciasteczko `HttpOnly; Secure; SameSite=Strict`, ponowne logowanie kluczem,
  zero naruszeń CSP i błędów konsoli; jedyne błędy HTTP: `401 /api/me` przed zalogowaniem, `404 /api/auth/dev-users`).
- Nie sprawdzono: instalacji `pnpm install --prod` na czystym serwerze, reverse proxy z TLS (brak serwera/domeny).

### Pamięć dokumentów: PDF/TXT/Markdown ze źródłami (2026-09-26)

- Baza: migracja `0010_documents.sql` (`documents`, `document_blobs` z oryginałem, `document_chunks` z lokalizacją
  i `tsvector`), RLS jak w pozostałych danych: prywatny — tylko właściciel; wspólny — aktywni członkowie i NovaAI.
- Odczyt: PDF przez pdfjs-dist w osobnym wątku (limit 30 s i 256 MB; plik zaszyfrowany, uszkodzony, skan bez tekstu,
  > 500 stron ⇒ status „błąd odczytu” z komunikatem), TXT/Markdown jako UTF-8 z zapasem Windows-1250, pliki binarne
  > odrzucane. Fragmenty ~900 znaków, nigdy przez granicę strony PDF; w TXT/MD zakres linii i ścieżka nagłówków.
- Indeksowanie w trwałej kolejce (`document.index`, bez modelu i kosztów) z wersjonowaniem: ponowne indeksowanie
  unieważnia starsze zadanie, stare fragmenty działają do końca nowego indeksu; usunięcie usuwa oryginał i fragmenty.
- Limity: 10 MB na plik, 200 dokumentów i 200 MB na osobę, duplikat (ten sam plik u tej samej osoby) ⇒ 409.
- Wyszukiwanie: najpierw lista dokumentów dozwolonych w kontekście (RLS + polityka `document.read`, rozbieżność ⇒ audyt),
  dopiero potem fragmenty wyłącznie z nich. Pełnotekstowe w Postgres: normalizacja polskich znaków, termy przycinane
  o typowe końcówki (odmiana), ranking ważony rzadkością termu (IDF w obrębie dozwolonych dokumentów).
- Agent: do tury trafia maks. 4 fragmenty (≥ 2 dopasowane termy przy dłuższym pytaniu), jako oznaczony blok DANYCH
  w wiadomości użytkownika (nie w prompcie systemowym) z odwołaniami [D1]. Odpowiedź zapisuje `sources` (dokument,
  strona/linie/nagłówek, czy zacytowany) — bez treści. Tryb demo odpowiada cytatem z fragmentu.
- Niezaufany kontekst: gdy w turze są fragmenty dokumentów lub wyniki narzędzi, każde narzędzie ze skutkami wymaga
  zgody (nawet `memory.create`); broker weryfikuje zgodę zawsze, gdy krok ją ma.
- API: `POST /api/documents?name=&space=` (surowe bajty), `GET /api/documents?space=`, `GET /api/documents/search?q=`,
  `GET /api/documents/:id`, `GET /api/documents/:id/chunks/:ord`, `GET /api/documents/:id/file` (załącznik + CSP sandbox),
  `POST /api/documents/:id/share|unshare|reindex`, `DELETE /api/documents/:id`. Zdarzenie `document.updated`.
- UI: Pamięć → Dokumenty (także w menu bocznym): dodawanie (przycisk + upuszczanie, walidacja przed wysłaniem),
  wyszukiwarka z zaznaczonymi trafieniami, lista ze statusem, udostępnianiem, ponownym indeksowaniem, pobraniem
  i usuwaniem; widok fragmentu (strona/linie, poprzedni/następny). W czacie pod odpowiedzią „Źródła” z odnośnikiem
  do fragmentu.
- Znalezione i poprawione przy okazji: klient SSE miał własną listę typów zdarzeń (nowy typ był ignorowany) — lista
  jest teraz w `@nova/contracts/event-types` wspólna dla serwera i przeglądarki.
- Polecenia i wyniki: `pnpm check` → contracts 4/4, permissions 27/27, api 183/183, web 4/4 (nowe: `text.test.ts` 11,
  `documents.test.ts` 11, `documents-agent.test.ts` 9, policy 3); `pnpm test:e2e` → 20/20 (nowy `documents.spec.ts`
  na desktopie i telefonie: dodanie PDF, wyszukanie, odpowiedź ze źródłem „s. 2”, fragment, błędy plików, Beta nie widzi
  dokumentu Alfy w liście, wyszukiwaniu i odpowiedzi); `pnpm test:prod-smoke` → 1/1 (PDF w bundlu produkcyjnym).
- Granica weryfikacji: brak klucza modelu — „model” w testach to FakeProvider. Sprawdzone jest, co serwer wysyła do
  modelu (brak cudzych dokumentów, fragmenty jako dane, brak treści w prompcie systemowym) i co robi z odpowiedzią
  (źródła, zgody). Nie sprawdzono, jak prawdziwy model cytuje źródła ani jak opiera się wstrzyknięciom — dlatego
  zgoda przy niezaufanym kontekście jest wymuszana po stronie serwera, niezależnie od modelu. Wyszukiwanie jest
  leksykalne (bez embeddingów): pytania innymi słowami niż w dokumencie mogą nie znaleźć fragmentu. Brak OCR skanów.

### Przegląd interfejsu na zrzutach — desktop i telefon (2026-09-26)

- Metoda: `apps/web/scripts/ui-review.mjs` — dane przez API (konta testowe, tryb demo), 60 zrzutów: każdy widok na
  desktopie (1360×860) i Pixel 7, jasny i ciemny motyw, puste stany (Beta), błąd serwera (500), offline.
- Poprawione usterki (wszystkie widoczne na zrzutach przed poprawką):
  1. Wynik akcji w czacie był podpisany „Użytkownik” i wyglądał jak wiadomość osoby → osobny styl „Wynik akcji: …”.
  2. Każda rozmowa nazywała się „Nowa rozmowa” → tytuł z pierwszej wiadomości (API; własny tytuł nie jest nadpisywany).
  3. Wszystkie zadania czatu nazywały się „Odpowiedź: Asystent Alfy” → „Odpowiedź: „<początek pytania>”” (Zadania, Aktywność).
  4. Kroki zadania pokazywały wewnętrzne klucze („po: collect”) → nazwy kroków.
  5. Znacznik źródła „D1” łamał się na telefonie w dwie linie → bez łamania, opis zawija się pod spodem.
  6. Przyciski rozciągnięte na szerokość (budżet, przypomnienia na telefonie, zadanie demo) miały tekst przy lewej
     krawędzi i wyglądały jak pola → treść wyśrodkowana.
  7. Długi status „tryb demo — brak skonfigurowanego dostawcy” wychodził poza panel Ustawień na telefonie → zawijanie.
  8. Status zadania na stronie Dom rozciągał się na całą szerokość → rozmiar treści; przypomnienia nie dublują się
     w „Aktywnych wspólnych zadaniach”.
  9. Przy braku połączenia lista przypomnień pokazywała „Brak przypomnień” (nieprawda) → pusty stan tylko po udanym
     wczytaniu; błąd sekcji wiadomości/zadań pokazany przy nich, nie nad całą stroną.
  10. Wycinki i cytaty dokumentów zawierały znaczniki `##`, a sam nagłówek H1 tworzył osobny, pusty fragment → tekst bez
      znaczników, nagłówki łączone z treścią sekcji.
  11. Natywne pole pliku pokazywało „Choose Files / No file chosen”, Aktywność — surowy status „ready” → przycisk
      „Wybierz pliki” i polskie statusy dokumentów z odnośnikiem.
  12. Puste stany bez wskazówki (Zgody, Wiadomości, Przypomnienia) i błąd gramatyczny („z Asystent Bety”) → konkretne
      wskazówki, co zrobić. Przycisk zadania demonstracyjnego ukryty w produkcji.
  13. (Druga runda zrzutów) Na liście przypomnień nie było widać, które są wspólne → oznaczenie „dla domowników” /
      „od: …” / „tylko dla mnie”; pole daty w formularzu przypomnień i kalendarza lokalnego ucinało początek → szersza kolumna.
- Zrzuty w `docs/screens/` odświeżone z e2e (`E2E_SCREENSHOTS=1`), w tym nowe: dokumenty, źródła w czacie, fragment.
- Nie zmieniono: format pola daty w przeglądarce (natywne, zależy od języka przeglądarki/systemu).
- Polecenia i wyniki: `pnpm check` → contracts 4/4, permissions 27/27, api 187/187 (nowe: `conversations.test.ts` 2,
  testy fragmentów Markdown i wycinków), web 4/4; `pnpm test:e2e` → 20/20 (test NovaAI wyszukuje rozmowę po tytule).

## Blokady

- Brak demona Docker w sesji zdalnej — `infra/compose.yaml` nieprzetestowany tutaj (używany lokalny klaster).
- Brak systemu Windows w sesji: Worker Rust sprawdzony na Linuksie (testy + interop z API) i kompilacyjnie dla
  `x86_64-pc-windows-gnu` (bez TLS — brak kompilatora mingw; nie instalowałem pakietów systemowych). Test ręczny:
  `workers/windows/README.md`.
- Brak kont OAuth (Google Cloud client, Microsoft, Slack) — integracje sprawdzone wyłącznie na lokalnych mockach.
  Do uruchomienia: klient OAuth „Web application”, redirect `<NOVA_PUBLIC_URL>/api/connections/google/callback`,
  `GOOGLE_CLIENT_ID/SECRET`, `NOVA_SECRET_KEY`; weryfikacja zakresów Gmail przez Google przed udostępnieniem.
- Brak kluczy API i instalacji Hermesa — adaptery modeli nie były uruchomione przeciwko prawdziwym usługom
  (świadomie: zakaz płatnych wywołań). Ceny modeli do uzupełnienia przez właściciela z oficjalnego cennika.

## Niezaimplementowane (poza blokadami)

- Adapter Honcho dla `episodic`; wyszukiwanie semantyczne (embeddingi) i OCR skanów w pamięci dokumentów.
- Worker: procesy, uruchamianie aplikacji, brokerowane komendy / PowerShell, przeglądarka, zrzuty ekranu, UI Automation
  (spec, sekcja 6, punkty 4–5). Zaimplementowane: pliki (lista/odczyt/zapis z diffem i kopią) oraz git status/diff.
- Integracje Microsoft (Outlook/Calendar/Teams) i Slack OAuth (jest tylko weryfikowany webhook Slack); Google Drive.
- Web Push (VAPID) — powiadomienia działają w otwartej aplikacji (SSE + lista); transkrypcja głosu po stronie serwera.
- Edycja kalendarza Google (jest tylko odczyt zajętości z grantem i kalendarz lokalny).

## Następne 3 zadania

1. Uruchomienie z prawdziwymi usługami przez właściciela: klucz modelu + cennik w `models.local.json`, klient OAuth Google,
   Worker na Windows wg `workers/windows/README.md` (w tym test junction).
2. Konfiguracja wdrożenia przez właściciela: reverse proxy z TLS, kopie zapasowe Postgres, usługa systemowa dla `start:prod`.
3. Pamięć dokumentów z prawdziwym modelem: ocena cytowania źródeł i odporności na wstrzyknięcia na zestawie pytań;
   rozważyć wyszukiwanie semantyczne (pgvector + lokalne embeddingi) i OCR skanów. Potem Web Push (VAPID).
