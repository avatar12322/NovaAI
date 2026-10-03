# Postęp prac NovaAI

Aktualizowane po każdej pionowej funkcji. Tylko fakty potwierdzone poleceniami w tej sesji.

## Status etapów

| Etap                     | Status    | Uwagi                                                                                                                             |
| ------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| M0 — szkielet            | gotowe    | workspace, API, web, Postgres lokalny, migracje, healthcheck; Compose nieprzetestowany (brak Dockera)                             |
| M1 — izolacja            | gotowe    | sesje, polityka + RLS, rozmowy, pamięć, udostępnianie, audyt; testy izolacji Alfa/Beta                                            |
| M2 — UI i zadania        | gotowe    | trwała kolejka, zgody, SSE, UI desktop/telefon, PWA; e2e                                                                          |
| M3 — model i pamięć      | częściowe | brama modeli, budżet, broker, wyniki narzędzi → model; adaptery Anthropic/Hermes tylko na mockach (brak kluczy)                   |
| M4 — Worker              | częściowe | protokół, symulator, Worker Rust (Linux + interop z API); na Windows tylko kompilacja, bez uruchomienia                           |
| M5 — integracje          | częściowe | Google, Microsoft (Outlook) i Slack tylko na atrapach — połączenie z kontami i workspace NIESPRAWDZONE; Teams niezaimplementowany |
| M6 — głos i proaktywność | częściowe | przypomnienia, powiadomienia w aplikacji, dyktowanie/odczyt w przeglądarce; brak Web Push i transkrypcji serwerowej               |
| Passkeys + bootstrap     | gotowe    | WebAuthn (testy API z programowym uwierzytelniaczem, e2e z wirtualnym Chromium), CLI admin                                        |
| Utwardzenie              | gotowe    | limity tras bez sesji, redakcja URL w logach, `NOVA_TRUST_PROXY`, sprzątanie wygasłych artefaktów                                 |
| Ścieżka produkcyjna      | częściowe | bundel API + frontend z API + CSP, smoke w `NOVA_ENV=production`; bez realnego serwera, TLS i domeny                              |
| Pamięć dokumentów        | gotowe*   | PDF/TXT/Markdown, indeksowanie, wyszukiwanie po uprawnieniach, źródła w odpowiedzi, UI; *model tylko jako atrapa                  |
| Usługi i koszty          | gotowe*   | rejestr usług, koszty i faktury, budżety, odnowienia; *adaptery raportów kosztów tylko na atrapie — niepodłączone                 |
| Modele AI i klucze API   | gotowe*   | dostawcy i klucze dodawane w aplikacji (szyfrowane), modele z cennikiem, kursy; *tylko na atrapie — bez prawdziwych kluczy        |

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

### Microsoft Graph: Outlook — poczta i kalendarz (2026-09-26)

Gałąź `claude/novaai-microsoft-graph` (od `claude/novaai-documents`). **Połączenie z Microsoftem nie zostało
sprawdzone** — brak konta i rejestracji aplikacji; całość zweryfikowana na lokalnej atrapie Microsoft identity platform
i Graph odtwarzającej kontrakt z dokumentacji (sprawdzonej 2026-09-26, szczegóły i źródła: `docs/DECISIONS.md` D-027).

- `MicrosoftConnector` (`apps/api/src/connectors/microsoft.ts`): OAuth v2.0 z PKCE S256 osobno dla każdego
  użytkownika, `MICROSOFT_CLIENT_ID/SECRET/TENANT` (domyślnie `common`), najmniejsze uprawnienia per zdolność
  (`Mail.ReadBasic`, `Mail.Read`, `Mail.Send`, `Calendars.ReadBasic`; `Mail.ReadWrite` tylko dla szkiców), rotacja
  refresh tokenu, mapowanie 401/403/404/429/5xx, stronicowanie kalendarza tylko w obrębie Graph.
- `ConnectionService`: wybór konta dla zdolności (`resolve`, odmowa przy dwóch kontach bez wskazania), wywołania
  z jednym wymuszonym odświeżeniem po 401 (`call`), odświeżanie pod blokadą wiersza, stan „wymaga ponownego
  połączenia”, etykieta konta i wybór zdolności zapisane przy połączeniu (migracja `0011_connection_account.sql`).
- Narzędzia niezależne od dostawcy: `mail.search`, `mail.read`, `mail.send` (zgoda), nowe `mail.draft` (zawsze zgoda,
  szkic w Outlooku bez wysyłki) i `calendar.events` (tylko agent prywatny); `calendar.freebusy` łączy Google i Outlook,
  NovaAI dostaje tylko przedziały, a błąd konta jednej osoby nie blokuje innych. Google: 401 → odświeżenie i ponowienie.
- UI (Ustawienia → Integracje): stan połączenia z kontem, „nie połączono” / „wymaga ponownego połączenia”, wybór
  uprawnień z nazwami uprawnień Microsoft (wysyłka i szkice domyślnie wyłączone), nieprzyznane uprawnienia, notatka
  „Microsoft Teams — wymaga zgody administratora organizacji”, zasady kont służbowych, jak cofnąć zgodę u Microsoft.
  Komunikat po powrocie z odmową administratora organizacji. Czat i kroki zadań pokazują czytelny powód odmowy
  (brak konta, wygasły dostęp, brak uprawnienia, dwa konta). Komendy demo: `szkic maila do …`, `wydarzenia: od do`,
  słowo `outlook`/`gmail` po poleceniu.
- Testy (`apps/api/src/connectors/microsoft.test.ts`, 26, dane fikcyjne `example.test`): stan bez konfiguracji i notatka
  Teams; URL autoryzacji z minimalnymi zakresami, state, PKCE i `select_account`; wymiana kodu z weryfikatorem,
  zaszyfrowane tokeny, brak tokenów w odpowiedziach i audycie, rola aplikacji bez dostępu do szyfrogramu;
  normalizacja zakresów i widoczny brak przyznanego uprawnienia; jednorazowy state i przechwycony kod bez weryfikatora;
  rozpoznanie wymogu zgody administratora (bez zapisu opisu błędu); **izolacja Alfa/Beta** (każde wywołanie Graph
  tokenem właściciela, cudzy identyfikator wiadomości → 404, odłączenie Bety nie wpływa na Alfę); NovaAI bez narzędzi
  poczty i szczegółów kalendarza; **odświeżanie** z rotacją refresh tokenu, jedno odświeżenie przy trzech równoległych
  żądaniach, 401 → odświeżenie → ponowienie; **cofnięcie dostępu** po stronie Microsoft → stan „wymaga ponownego
  połączenia”, kolejne prośby odrzucane bez wywołań, inni użytkownicy bez zmian; odłączenie usuwa tokeny i blokuje
  wywołania; wysyłka i szkic tylko po zgodzie (dokładnie jedno `sendMail`, odrzucona zgoda nie tworzy szkicu); treść
  maila z „instrukcjami” pozostaje danymi; wybór konta przy dwóch kontach; wydarzenia ze stronicowaniem i czasem UTC;
  połączenie „tylko zajętość” nie daje tytułów mimo tego samego uprawnienia; zajętość dla NovaAI bez tytułów;
  walidacja adresu i nagłówków; `$search` z ucieczką; brak podążania za adresem następnej strony spoza Graph.
  Sprawdzono też, że testy wykrywają zepsucie: wyłączenie ograniczenia do wybranych zdolności i ponownego sprawdzenia
  pod blokadą powodowało porażki odpowiednich testów.
- e2e `apps/web/e2e/integrations.spec.ts` (desktop + telefon): stan „nie połączono”, domyślne uprawnienia, notatka Teams,
  adres logowania Microsoft z minimalnymi zakresami (przekierowanie przechwycone w przeglądarce — nic nie trafia do
  Microsoft; w e2e ustawiony testowy `MICROSOFT_CLIENT_ID` i klucz sejfu), komunikat o zgodzie administratora, czytelna
  odmowa w czacie. Zrzuty: `docs/screens/*-13-integrations-microsoft.png`; pozostałe zrzuty odświeżone.
  Stany „połączono” i „wymaga ponownego połączenia” obejrzane jednorazowo na zrzucie z wierszem połączenia bez tokenów
  (nie dołączono do repozytorium).
- Polecenia i wyniki: `pnpm check` → contracts 4/4, permissions 27/27, api 213/213 (w tym Microsoft 26, Google 14 po
  zmianach), web 5/5; `pnpm test:e2e` → 24/24; `pnpm test:prod-smoke` → 1/1; `pnpm worker:test` → 18/18.
- Niesprawdzone (wymaga konta i rejestracji aplikacji w Microsoft Entra): prawdziwe logowanie i ekrany zgody,
  zachowanie dzierżaw z ograniczonymi zgodami (kody AADSTS, powrót do aplikacji), semantyka i limity `$search`,
  format identyfikatorów wiadomości, `webLink` szkicu, limity 429.

### Slack: wzmianki, wiadomości i wysyłka przez zgody (2026-09-26)

Gałąź `claude/novaai-slack` (od `claude/novaai-microsoft-graph`). **Integracja nie została sprawdzona ze Slackiem** —
brak aplikacji i workspace’u; całość zweryfikowana na lokalnej atrapie Slack OAuth v2, Web API i Events API
odtwarzającej kontrakt z dokumentacji (sprawdzonej 2026-09-26; źródła i decyzje: `docs/DECISIONS.md` D-028).

- `SlackConnector` (`apps/api/src/connectors/slack.ts`): osobne połączenie każdej osoby, wyłącznie zakresy użytkownika,
  tożsamość potwierdzana `auth.test`, opcjonalna rotacja tokenów, `auth.revoke` przy odłączeniu, mapowanie błędów
  (token odwołany/wygasły, brak zakresu, limit zapytań, brak sieci, przekroczony czas, błędy kanału).
- Odczyt przez Real-time Search API (`assistant.search.context`) tokenem tej osoby; najmniejsze zakresy:
  `search:read.public`, opcjonalnie `search:read.private` oraz `search:read.im` + `search:read.mpim`. `search.messages`
  pominięte — dokumentacja oznacza je jako przestarzałe.
- **Treść ze Slacka nie jest zapisywana** (zasady Real-time Search API): narzędzia `slack.mentions` i `slack.search`
  zapisują tylko liczbę i parametry; treść pobierana na żywo — w czacie („Pokaż na żywo”, `no-store`) i dla modelu
  w turze uzupełniającej. Test przeszukuje całą bazę pod kątem treści wiadomości.
- `slack.send`: tylko po zgodzie; nazwa kanału, członkostwo i archiwizacja ze Slacka (nie od modelu), konto nadawcy
  w podglądzie, bez rozwijania linków, odpowiedzi w wątku; rozmowy bezpośrednie/grupowe nieobsługiwane.
- Events API: podpisane `tokens_revoked` i `app_uninstalled` oznaczają połączenia jako „dostęp cofnięty w Slacku”,
  usuwają tokeny i wysyłają powiadomienie właścicielowi; ponowienia (ten sam `event_id`) tylko liczone; błąd
  przetwarzania ⇒ 500 bez zapisu dostawy, ponowienie przetwarza. Jedno konto Slack = jedna osoba NovaAI (migracja 0012).
- Odłączenie (wszyscy dostawcy) zwraca, czy dostawca potwierdził odwołanie (Google/Slack: tak/nie, Microsoft: brak API).
  401/`token_revoked` z API dostawcy od razu oznacza połączenie jako „wymaga ponownego połączenia”.
- UI: karta Slack z wyborem dostępu (domyślnie tylko kanały publiczne), statusem każdego uprawnienia, stanem
  „dostęp cofnięty w Slacku”; komunikat po odłączeniu; czytelne odmowy Slacka w czacie i krokach zadań.
  Pole grantu zajętości w Kalendarzu nie łamie się już na telefonie. Przycisk „Pokaż na żywo” i błąd bez połączenia
  obejrzane jednorazowo na zrzucie z ręcznie wstawionym wynikiem narzędzia (nie dołączono do repozytorium).
- Testy (`apps/api/src/connectors/slack.test.ts`, 27, dane fikcyjne): stan bez konfiguracji; zakresy per zdolność;
  URL autoryzacji tylko z `user_scope`; wymiana kodu z `auth.test`, tokeny zaszyfrowane, identyfikatory konta;
  odrzucenie cudzego konta Slack; odmowa i zły kod; **izolacja** (każda osoba własnym tokenem widzi tylko swoje
  wzmianki; rozmowa bezpośrednia Alfy i kanał bez członkostwa Bety niewidoczne dla Bety; typy rozmów zgodne z
  wybranym dostępem); NovaAI bez narzędzi Slacka; **brak zapisu treści** (także w turze modelu); wysyłka i odpowiedź
  w wątku tylko po zgodzie, odrzucona zgoda niczego nie wysyła, czytelne odmowy (brak członkostwa, archiwum, rozmowa
  grupowa, rozmowa bezpośrednia, brak uprawnienia), konto odłączone po zgodzie blokuje wysyłkę; **odłączenie**
  (`auth.revoke`, brak potwierdzenia przy niedostępnym Slacku); **zdarzenia** (odwołanie tokenów z powiadomieniem,
  dwa ponowienia bez ponownego przetworzenia, błąd przetwarzania ⇒ 500 i przetworzenie przy ponowieniu,
  odinstalowanie w jednym workspace bez wpływu na inny, ignorowane zdarzenia bez zapisu treści, zły podpis i stary
  znacznik czasu); **błędy połączenia** (429 ⇒ ponowienie kroku i 503 w API na żywo, brak sieci ⇒ błąd kroku bez utraty
  konta, token odwołany bez zdarzenia, rotacja z jednorazowym refresh tokenem i `token_expired` ⇒ odświeżenie
  i ponowienie, brak zakresu, wyłączone wyszukiwanie, przekroczony czas odpowiedzi). Kontrola testów: zapisanie treści
  w wyniku narzędzia i wyłączenie deduplikacji ponowień powodowały porażki odpowiednich testów.
- Zgłoszenie skanera sekretów (`infra/compose.yaml`, hasło deweloperskie kontenera Postgres): hasło usunięte z pliku,
  Compose wymaga `NOVA_PG_SUPERUSER_PASSWORD` z lokalnego `.env` (sprawdzone `docker compose config` — z hasłem
  poprawna konfiguracja, bez hasła jawny błąd; kontenera nie uruchamiano — brak demona Docker). Stara wartość
  pozostaje w historii Gita (tylko lokalny dev, loopback); przepisanie historii wymagałoby decyzji właściciela.
- Polecenia i wyniki: `pnpm check` → contracts 4/4, permissions 27/27, api 240/240 (w tym Slack 27, Microsoft 26,
  Google 14), web 5/5; `pnpm test:e2e` → 26/26; `pnpm test:prod-smoke` → 1/1; `pnpm worker:test` → 18/18.
- Niesprawdzone (wymaga aplikacji Slack i workspace’u): prawdziwe logowanie i ekran zgody, dostępność Real-time
  Search API dla aplikacji wewnętrznej (i ustawienia „funkcji AI”), składnia zapytania o wzmianki, limity zapytań,
  zatwierdzanie aplikacji przez administratora, faktyczne dostarczanie zdarzeń `tokens_revoked`/`app_uninstalled`
  i ich ponowień, zachowanie przy włączonej rotacji tokenów.

### Poprawka: czarny ekran po otwarciu nowej rozmowy (2026-09-26)

- Zgłoszenie: lokalnie (`http://localhost:5173/#/chat/private/<id>`) nowa rozmowa dawała czarny ekran; w konsoli
  „useEffect must not return anything besides a function” i „destroy is not a function” w `ConversationPane`.
- Przyczyna: efekt przewijania był skróconą strzałką zwracającą wynik `scrollIntoView(...)`. W nowszych przeglądarkach
  metoda zwraca Promise, a React traktuje wartość zwróconą z efektu jako funkcję sprzątającą — błąd odmontowywał całą
  aplikację (w ciemnym motywie zostaje czarne tło). Testowy Chromium 141 zwraca jeszcze `undefined`, więc e2e tego nie
  wykrywały.
- Naprawa: efekt w bloku; granice błędów (`ErrorBoundary`) wokół całej aplikacji, widoku i panelu rozmowy — błąd
  pokazuje czytelny komunikat, a nawigacja działa dalej; reguła ESLint zabrania skróconych strzałek w
  `useEffect`/`useLayoutEffect` (sprawdzone: zgłasza dawny kod).
- Testy: `apps/web/e2e/browser-compat.spec.ts` — symulacja `scrollIntoView` zwracającego Promise (przed poprawką
  odtwarzał dokładnie ten błąd, po poprawce przechodzi) i błąd w widoku ⇒ komunikat zamiast pustego ekranu.
  `pnpm check` → 4/4, 27/27, 240/240, 5/5; `pnpm test:e2e` → 30/30; `pnpm test:prod-smoke` → 1/1.
- Niesprawdzone: przeglądarka zgłaszającego (wersja nieznana) — zachowanie odtworzone symulacją.

### Usługi i koszty (2026-09-26)

Gałąź `claude/novaai-services-costs` od `claude/novaai-slack` (najnowsza gałąź z pamięcią dokumentów). Decyzje:
`docs/DECISIONS.md` D-029.

- Migracja `0013_services_costs.sql`: `services`, `service_costs`, `cost_adapter_runs`; RLS jak w dokumentach
  (prywatne — właściciel; wspólne — domownicy czytają; zapis tylko właściciel). Polityka: `service.read/create/manage/
share/unshare` (agent nie tworzy ani nie zmienia usług).
- API: lista i szczegóły usług ze stanem miesiąca, suma miesiąca (`/api/costs/summary`), wpisy kosztów, import faktur
  CSV, udostępnianie, „odnowiono”, adaptery (`/api/cost-adapters`, synchronizacja na żądanie).
- Suma miesiąca: faktura > raport dostawcy > szacunek w obrębie usługi i miesiąca (bez podwójnego liczenia); szacunek
  z zapisanych kosztów wywołań modeli; waluty osobno, bez przeliczania; budżet tylko w walucie usługi; jedno
  powiadomienie o przekroczeniu na usługę i miesiąc.
- Odnowienia: przypomnienia w trwałej kolejce (N dni wcześniej, 9:00 czasu polskiego), przestawiane i anulowane razem
  z usługą; „odnowiono” zachowuje dzień miesiąca.
- Bez haseł i kluczy: odrzucane pola wyglądające na sekrety i linki z danymi logowania; klucze administracyjne
  adapterów tylko w konfiguracji serwera.
- Adaptery Anthropic (Cost API) i OpenAI (Costs API) według dokumentacji z 2026-09-26; stan „niepodłączone” do czasu
  udanej synchronizacji. **Nie sprawdzone na prawdziwych kontach** — brak kluczy administracyjnych.
- UI: widok „Usługi i koszty” (menu boczne; na telefonie przez Ustawienia) — suma miesiąca z podziałem na faktury
  opłacone / do zapłaty, raporty i szacunki, karty usług z budżetem i odnowieniem, szczegóły z wpisami (wpisy
  niewliczone oznaczone), dodawanie kosztu, import CSV, udostępnianie, panel adapterów. Walidacja pokazuje konkretny
  powód (np. „Nie wpisuj tu haseł ani kluczy API”). Zrzuty: `docs/screens/*-15-services.png`, `*-16-service-detail.png`.
- Testy (`apps/api/src/services/services.test.ts`, 16): **izolacja** Alfa/Beta (API i RLS, udostępnienie tylko do
  odczytu, cofnięcie, zakres NovaAI, dostawca modeli przypisany do cudzej usługi bez ujawniania nazwy); **brak
  podwójnego liczenia** (szacunek → raport → faktura, szacunek z wywołań modeli zastąpiony fakturą, osobne miesiące);
  **waluty** (USD/EUR/JPY osobno, budżet tylko w walucie usługi, miejsca po przecinku per waluta, nieznany kod);
  **odnowienia** (termin i strefa czasowa, zmiana daty, anulowanie, wspólne przypomnienie dostarczone obojgu,
  „odnowiono” 31.01 → 28/29.02 → 31.03, kwartał, rok przestępny); **budżet** (blisko limitu, przekroczenie, jedno
  powiadomienie, faktura niższa niż raport); **powtórny import faktury** (numer z inną wielkością liter, CSV dwa razy,
  faktura bez numeru, błędny CSV bez częściowego zapisu); **sekrety**; **adaptery** na atrapie (brak klucza,
  stronicowanie, centy jako tekst dziesiętny, aktualizacja bez duplikatów, błąd klucza ⇒ „błąd”, OpenAI w dolarach,
  synchronizacja tylko przez właściciela, brak kluczy w odpowiedziach i audycie). Kontrola testów: liczenie wszystkich
  źródeł naraz i losowy klucz deduplikacji faktur powodowały porażki odpowiednich testów.
- e2e `apps/web/e2e/services.spec.ts` (desktop + telefon): dodanie usługi, odrzucone hasło w notatkach, szacunek →
  raport → faktura (liczona tylko faktura), przekroczony budżet, odrzucona ta sama faktura, adaptery „niepodłączone”,
  udostępnienie Becie tylko do odczytu.
- Polecenia i wyniki: `pnpm check` → contracts 4/4, permissions 29/29, api 256/256 (w tym usługi 16), web 5/5;
  `pnpm test:e2e` → 32/32; `pnpm test:prod-smoke` → 1/1; `pnpm worker:test` → 18/18.
- Niesprawdzone: synchronizacja z prawdziwymi kontami Anthropic i OpenAI (klucze administracyjne), zachowanie
  przy dużych organizacjach (wiele stron raportu), adaptery innych dostawców (VPS, domeny — wpisy ręczne).

### Poprawka: „Błąd serwera” w filtrze „Prywatne” (Usługi i koszty, 2026-09-26)

- Zgłoszenie: w „Usługi i koszty” kliknięcie „Prywatne” dawało „Błąd serwera”.
- Przyczyna: zapytanie listy dla filtra „Prywatne” nie używa identyfikatora domu, a dostawało go jako parametr —
  Postgres odrzuca nadmiarowe parametry (500). Testy sprawdzały tylko „Wszystkie” i „Wspólne”.
- Naprawa: parametr tylko dla filtrów, które go używają; po błędzie widok nie pokazuje już danych z poprzedniego
  filtra (tylko błąd i „Spróbuj ponownie”).
- Testy: nowy test API — lista i suma miesiąca dla „Prywatne”, „Wspólne”, „Wszystkie” u dwóch osób (przed poprawką
  odtwarzał 500); e2e klika filtry i sprawdza brak błędu. `pnpm check` → 4/4, 29/29, 257/257, 5/5;
  `pnpm test:e2e` → 32/32.

### Modele AI i klucze API (2026-09-26)

Gałąź `claude/novaai-model-providers` od `claude/novaai-services-costs`. Decyzje: `docs/DECISIONS.md` D-030.

- Migracja `0014_model_providers.sql`: `model_providers` (klucz jako szyfrogram + 4 ostatnie znaki),
  `household_models` (cennik, zastosowanie, priorytet, polityka danych), `household_fx`; RLS — odczyt dla domowników,
  kolumna z szyfrogramem niedostępna dla roli aplikacji; zapis tylko przez serwer.
- Brama modeli: migawka per dom (plik + dostawcy domu), unieważniana po zmianie; `AutoAgentRuntime` wybiera model albo
  tryb demo w każdej turze — dodanie lub usunięcie klucza działa bez restartu. `/api/model/status` i `/api/health`
  (z sesją) pokazują stan domu. OpenAI (`api.openai.com`) dostaje `max_completion_tokens`.
- API (`/api/model/providers`, `/api/model/models`, `/api/model/fx`): zmiany tylko właściciel domu, domownik czyta;
  „Sprawdź klucz” = bezpłatna lista modeli; kolizja nazw z plikiem ⇒ 409; bez `NOVA_SECRET_KEY` ⇒ `no_vault`;
  `http://localhost` tylko przy `NOVA_MODELS_ALLOW_LOCAL`; `db:rotate-keys` obejmuje klucze dostawców.
- UI: „Modele AI” (menu boczne; na telefonie Ustawienia → Modele AI i klucze API) — gotowe ustawienia Anthropic /
  OpenAI / Gemini / inny zgodny z OpenAI z linkami do tworzenia klucza i cennika, pole klucza typu hasło (po zapisie
  tylko „•••• ABCD”), sprawdzenie, zmiana, wyłączenie i usunięcie klucza; modele z cennikiem (podpowiedzi
  identyfikatorów z „Sprawdź klucz”), edycja, kursy walut z ostrzeżeniem o brakującym kursie; widok domownika tylko
  do odczytu. „Usługi i koszty” proponuje nazwy dostawców dodanych w aplikacji. Zrzuty:
  `docs/screens/*-17-models.png`.
- Testy (`apps/api/src/model/household-models.test.ts`, 13, lokalna atrapa HTTP): uprawnienia właściciel/domownik
  (403 dla każdej zmiany), izolacja domów (niewidoczne, 404, migawka innego domu bez modeli), klucz nie wraca
  w odpowiedziach ani audycie i nie leży jawnie w bazie, rola aplikacji nie czyta szyfrogramu (42501), szyfrogram
  przeniesiony do innego rekordu nie daje się odszyfrować (i nie wychodzi żadne żądanie), brak `NOVA_SECRET_KEY`,
  rotacja klucza głównego, walidacja adresów i kluczy (bez echa wartości), `NOVA_MODELS_ALLOW_LOCAL`, sprawdzenie
  klucza (OpenAI-zgodny: ok/401 bez treści odpowiedzi; Anthropic: `x-api-key` + `anthropic-version`; serwer
  niedostępny), rozmowa demo → model → demo bez restartu z kosztem w PLN po kursie (0,008 zł) zapisanym pod nazwą
  dostawcy i widocznym jako szacunek w „Usługi i koszty”, model „tylko wspólne” bez prywatnej rozmowy. Dodatkowo:
  kolejność tras i pamięć podręczna migawki (`gateway.test.ts`), `max_completion_tokens` (`providers.contract.test.ts`),
  walidacja adresów/kluczy (contracts), trasa `#/models` (web).
- e2e `apps/web/e2e/models.spec.ts` (desktop + telefon): dodanie dostawcy (adres w domenie `.test`, klucz testowy),
  tylko końcówka klucza na stronie, wyłączenie dostawcy, model z błędną i poprawną ceną, brakujący kurs USD→PLN i jego
  ustawienie, asystent nadal w trybie demo, domownik tylko do odczytu, usunięcie. „Sprawdź klucz” nie jest klikane —
  test nie wysyła niczego do dostawców.
- Polecenia i wyniki: `pnpm check` → contracts 6/6, permissions 29/29, api 272/272, web 6/6; `pnpm test:e2e` →
  34/34; `pnpm test:prod-smoke` → 1/1; `pnpm worker:test` → 18/18.
- Niesprawdzone: prawdziwe klucze Anthropic, OpenAI i Gemini (lista modeli i rozmowa) — świadomie bez płatnych API;
  warstwa zgodności Gemini jest w wersji beta.

### Poprawka: klucz z `.env` „nie działa”, preset Anthropic „nazwa zajęta” (2026-09-26)

- Zgłoszenie: klucze dodane do `.env`, a asystent dalej w trybie demo; dodanie Claude w aplikacji kończyło się
  błędem „Nazwa „anthropic” jest używana przez konfigurację serwera”.
- Przyczyny: (1) klucz z `.env` był wczytany, ale modele z `models.example.json` celowo nie mają cennika, więc są
  niedostępne — strona pokazywała tylko „brak cennika (uzupełnij konfigurację)” bez wskazania, co zrobić;
  (2) reguła „nazwy z pliku mają pierwszeństwo” blokowała domyślną nazwę presetu `anthropic`.
- Naprawa: ustawienia domu mają pierwszeństwo przed plikiem (dostawca i model o tej samej nazwie zastępują plik
  tylko dla tego domu; wyłączony dostawca domu przywraca konfigurację serwera); model w aplikacji może korzystać
  z dostawcy z serwera — klucz zostaje w `.env` (migracja `0015`); sekcja „Z konfiguracji serwera (.env)” pokazuje
  „klucz wczytany” / brak klucza (nazwa zmiennej, nigdy wartość) i „brak cennika” z przyciskiem „Uzupełnij cennik”;
  formularz dostawcy podpowiada, że dostawca o tej nazwie już jest na serwerze; waluty bez kursu także dla modeli
  z pliku. D-030 uzupełnione.
- Testy: nowy test API odtwarzający zgłoszenie (plik jak `models.example.json`, klucz w zmiennej): stan „brak
  cennika” i brak kursu, model na kluczu serwera (wywołanie atrapy z kluczem ze zmiennej), preset `anthropic`
  bez błędu (przed poprawką 409) i pierwszeństwo jego klucza, wyłączenie ⇒ znów klucz serwera, usunięcie ⇒ model
  na dostawcy serwera zostaje; test bramy (zastąpienie dostawcy i modelu, trasy, wyłączony dostawca). e2e na
  konfiguracji jak domyślny `.env` (adres `.test`, klucz testowy): „klucz wczytany”, „brak cennika”, podpowiedź
  w formularzu, „Uzupełnij cennik”, tryb demo po usunięciu — bez żadnej rozmowy z modelem.
  Zrzut: `docs/screens/*-18-models-server-key.png`.
- Polecenia i wyniki: `pnpm check` → contracts 6/6, permissions 29/29, api 273/273, web 6/6; `pnpm test:e2e` →
  36/36; `pnpm test:prod-smoke` → 1/1; `pnpm worker:test` → 18/18.

### Poprawka: „nie mam dostępu do Twojego CV” mimo gotowego dokumentu (2026-09-26)

- Zgłoszenie: z prawdziwym modelem pytanie „co ciekawego jest w moim cv” (PDF, status „gotowy”) — odpowiedź, że
  asystent nie ma dostępu do dokumentów.
- Przyczyna: dobór fragmentów tylko po słowach pytania („cv” pomijane jako za krótkie, polskie słowa nie występują
  w angielskim CV) ⇒ zero fragmentów; model nie znał listy dokumentów i nie miał narzędzia do ich otwarcia.
- Naprawa (D-031): lista dostępnych dokumentów w każdej turze (tylko tytuły, jako dane), narzędzia
  `documents.read` i `documents.search` (tylko odczyt, bez zgody, te same uprawnienia co fragmenty, treść na żywo —
  bez zapisu w rozmowie), reguła w prompcie systemowym. Narzędzia dokumentów są udostępniane tylko, gdy w kontekście
  jest jakiś dokument.
- Testy (`documents-agent.test.ts`, syntetyczne CV po angielsku — bez prawdziwych danych): pytanie „co ciekawego
  jest w moim cv” ⇒ lista z dokumentem, brak fragmentów, `documents.read`, treść w turze uzupełniającej, w rozmowie
  tylko tytuł i zakres, bez zgody; Beta i NovaAI nie odczytają prywatnego dokumentu Alfy nawet z prawdziwym id
  (odmowa `document_not_available`, brak na liście); NovaAI wyszukuje we wspólnym dokumencie. Istniejący test
  fragmentów zaktualizowany (lista przed fragmentami).
- Polecenia i wyniki: `pnpm check` → contracts 6/6, permissions 29/29, api 276/276, web 6/6; `pnpm test:e2e` →
  36/36; `pnpm test:prod-smoke` → 1/1; `pnpm worker:test` → 18/18.
- Niesprawdzone: czy prawdziwy model za każdym razem sięgnie po narzędzie (zależy od modelu) — z atrapą sprawdzamy,
  co serwer wysyła i jak obsługuje propozycję.

### Animacje asystenta w czacie (2026-09-26)

Gałąź `claude/novaai-jarvis-ui` od `claude/novaai-model-providers`.

- Wskaźnik pracy asystenta: „kula” (akcent, bez gradientów), etap na żywo z kroków zadania („Myśli”, „Czyta
  dokument”, „Przeszukuje pocztę”, „Układa odpowiedź” + opis kroku), animowane kropki i paski „pisania”;
  trwa do końca całej tury (także narzędzi i odpowiedzi uzupełniającej), a nie do pierwszej wiadomości.
  Kula w nagłówku rozmowy: spoczynek / myśli; przycisk odczytu na głos pokazuje „equalizer” i zatrzymuje odczyt.
- Nowa odpowiedź odsłaniana słowami (0,35–1,6 s zależnie od długości; kliknięcie pokazuje całość), czytnik ekranu
  dostaje od razu pełny tekst; nowe wiadomości i widoki wchodzą płynnie; historia po ponownym otwarciu — bez
  animacji. „Ogranicz ruch” w systemie wyłącza animacje.
- Testy: jednostkowe (odsłanianie: granice słów, monotoniczność, czasy; etapy z kroków zadania), e2e
  `assistant-motion.spec.ts` (wskaźnik z etapem i kulą, animacja wejścia, brak animacji w historii, „ogranicz
  ruch” przez emulację mediów). Zrzut: `docs/screens/*-19-assistant-thinking.png`.
- Polecenia i wyniki: `pnpm check` → 6/6, 29/29, 276/276, web 9/9; `pnpm test:e2e` → 40/40;
  `pnpm test:prod-smoke` → 1/1.

### Odpowiedź na żywo (strumieniowanie, 2026-09-26)

- Claude (Anthropic) odpowiada na żywo: tekst pojawia się w czacie w trakcie pisania (dymek „pisze…” z kursorem),
  potem zastępuje go zapisana odpowiedź. Fragmenty nie są zapisywane; widzą je tylko odbiorcy rozmowy (D-032).
  Dostawcy zgodni z OpenAI — na razie bez strumieniowania.
- Testy: kontrakt SDK (strumień zdarzeń Messages API: fragmenty, narzędzie z `input_json_delta`, usage z
  `message_delta`), `live.test.ts` (łączenie co 50 ms, przesunięcia, ponowna próba; SSE: prywatna rozmowa —
  fragmenty tylko u właściciela i składają się w pełną odpowiedź, brak zapisu w bazie; wspólna — u domownika),
  web: doklejanie fragmentów (luki, powtórki, nowy krok/próba), porównanie z zapisaną odpowiedzią. Atrapa
  Anthropic w testach dostawców domu odpowiada strumieniem jak prawdziwe API.
- Niesprawdzone w przeglądarce e2e: sam dymek na żywo (tryb demo nie strumieniuje, a tura kończy się zbyt szybko)
  — logika pokryta testami jednostkowymi i API.

### Rozmowa głosowa bez rąk (2026-09-26)

- Przycisk „Rozmowa głosowa” w czacie: asystent słucha (rozpoznawanie mowy przeglądarki, za tą samą zgodą co
  dyktowanie), rozpoznana wypowiedź od razu trafia do rozmowy, ostatnia odpowiedź tury jest odczytywana na głos
  (bez znaczników i odnośników [D1]), potem znowu słucha — aż do „Zakończ rozmowę”. Kilka razy cisza z rzędu albo
  błąd mikrofonu kończy rozmowę z komunikatem. Pasek stanu: „Słucham”, „Myślę”, „Mówię”; kula w nagłówku ma
  osobną animację słuchania. Bez kosztów serwera (poza samą rozmową z modelem).
- e2e `voice.spec.ts` (atrapy rozpoznawania i syntezy mowy): pytanie wysłane bez klikania, odpowiedź odczytana,
  ponowne słuchanie, zakończenie. Zrzut: `docs/screens/*-20-voice-conversation.png`.
- Niesprawdzone: prawdziwy mikrofon i rozpoznawanie mowy w Chrome/Edge/Safari (środowisko bez audio).
- Polecenia i wyniki: `pnpm check` → 6/6, 29/29, 281/281, web 12/12; `pnpm test:e2e` → 42/42.

### Przegląd dnia (2026-09-26)

- „Dom” zaczyna się od przeglądu dnia: powitanie wg pory dnia (Europe/Warsaw), wydarzenia z kalendarza lokalnego,
  przypomnienia na dziś, zgody i zadania w toku, nieprzeczytane wiadomości, odnowienia usług w ciągu 7 dni,
  koszt modeli z limitem; „Przeczytaj przegląd” czyta krótkie podsumowanie na głos. `GET /api/briefing` — tylko
  przez RLS użytkownika (własne prywatne + wspólne), bez wywołań modelu.
- Testy: `briefing.test.ts` (dzień Alfy z każdą sekcją i tekstem do odczytu; Beta nie widzi prywatnych danych
  Alfy, widzi wspólne przypomnienie; pusty dzień; odmiana liczebników), e2e `briefing.spec.ts` (powitanie,
  kafelki, odczyt przez atrapę syntezy). Zrzut: `docs/screens/*-21-briefing.png`.
- Polecenia i wyniki: `pnpm check` → 6/6, 29/29, 285/285, web 12/12; `pnpm test:e2e` → 44/44.

### Głos ElevenLabs (2026-09-26)

- Odczyt odpowiedzi, rozmowa głosowa i przegląd dnia głosem ElevenLabs (głos `o2xdfKUpc1Bwq7RchZuW`, model
  `eleven_flash_v2_5`), gdy w `.env` jest `ELEVENLABS_API_KEY`; w przeciwnym razie albo po błędzie — głos
  przeglądarki. Serwer czyta tylko widoczne odpowiedzi i własny przegląd; limit znaków na dom, pamięć podręczna,
  limit zapytań, audyt bez treści (D-033). Migracja `0016_tts_usage.sql`.
- Testy: `voice/tts.test.ts` (atrapa ElevenLabs: adres, nagłówek `xi-api-key`, ciało, MP3, zużycie znaków, pamięć
  podręczna bez drugiego wywołania, cudza prywatna odpowiedź i wiadomość użytkownika ⇒ 404, dowolny tekst ⇒ 400,
  odpowiedź wspólna dla domownika, przegląd dnia, klucz odrzucony ⇒ 502 bez treści odpowiedzi dostawcy, limit ⇒
  429, brak klucza ⇒ 503), e2e `elevenlabs.spec.ts` (przegląd i odpowiedź przez `/api/tts`, status w Ustawieniach,
  powrót do głosu przeglądarki przy błędzie).
- Niesprawdzone: prawdziwe konto ElevenLabs i brzmienie wybranego głosu po polsku (brak klucza w sesji; zakaz
  płatnych wywołań w testach).
- Stabilność e2e: jedna porażka w pełnym przebiegu (nie w izolacji) okazała się wyścigiem w teście — na desktopie
  lista otwiera najnowszą rozmowę, a test pisał, zanim otworzyła się nowa (po przełączeniu pole było puste).
  Wspólny pomocnik `newConversation` czeka na pusty stan nowej rozmowy (tak robiły już starsze testy); limity
  czasu akcji (10 s) i nawigacji (15 s) wskazują teraz dokładny krok zamiast ogólnego przekroczenia czasu testu.
- Polecenia i wyniki: `pnpm check` → 6/6, 29/29, 291/291, web 12/12; `pnpm test:e2e` → 48/48 (dwa przebiegi po
  poprawce); `pnpm test:prod-smoke` → 1/1 (CSP z `media-src blob:`).

### Paleta poleceń (2026-09-26)

- Ctrl+K / Cmd+K (albo lupa w nagłówku na telefonie i „Polecenia” w menu): przejście do dowolnego widoku,
  nowa rozmowa, „Przeczytaj przegląd dnia”, jasny/ciemny motyw i „Zapytaj asystenta: …” — pytanie otwiera nową
  prywatną rozmowę, jest wysłane od razu, a rozmowa pokazuje pracę asystenta od pierwszej chwili. Wyszukiwanie
  bez polskich znaków („uslugi” → „Usługi i koszty”, także „ł”), obsługa klawiaturą (↑ ↓, Enter, Esc) i role ARIA
  (dialog, combobox, listbox).
- Poprawki przy okazji przeglądu zrzutów: przycisk-ikona (`button.icon-btn`) miał domyślną ramkę i tło
  przeglądarki; zrzuty ekranów robione w trakcie animacji wejścia (półprzezroczysty panel, niepełny przegląd
  dnia) — pomocnik `shot` czeka teraz na koniec skończonych animacji (najwyżej 2 s).
- Testy: `lib/commands.test.ts` (wyszukiwanie z polskimi znakami i bez, pytanie jako pierwsza propozycja, brak
  wyników), e2e `palette.spec.ts` (przejście, wyszukiwanie, strzałki, Esc, nieprzezroczysty panel po animacji,
  pytanie z palety z odpowiedzią). Zrzut: `docs/screens/*-22-command-palette.png`.
- Polecenia i wyniki: `pnpm check` → 6/6, 29/29, 291/291, web 15/15; `pnpm test:e2e` → 50/50;
  `pnpm test:prod-smoke` → 1/1.

### Rozpoznawanie mowy: czytelne błędy i zapas przez ElevenLabs (2026-09-26)

- Zgłoszenie: „Rozmowa głosowa” i dyktowanie → „Błąd rozpoznawania mowy”. Przyczyna po stronie aplikacji: każdy kod
  błędu przeglądarki poza `not-allowed` dawał ten sam komunikat, a przeglądarki bez usługi rozpoznawania (Brave,
  Opera, Vivaldi — błąd `network`; Firefox bez API) nie miały żadnej alternatywy. Dokładnej przeglądarki
  zgłaszającego nie znam — w Chromium w tej sesji rozpoznawania nie da się odtworzyć (brak zdarzeń).
- Teraz: konkretna przyczyna i co zrobić dla każdego kodu, widoczna nad polem wiadomości; po awarii usługi
  przeglądarki — nagranie rozpoznane przez serwer (ElevenLabs `scribe_v2`, ten sam klucz, limit minut, osobna
  zgoda), bez ponownego klikania (D-034). Migracja `0017_stt_usage.sql`.
- Testy: `voice/tts.test.ts` (+5: żądanie wg dokumentacji — multipart, `model_id`, `language_code`, plik;
  zużycie sekund; audyt bez treści i klucza; walidacja formatu, długości, logowania, CSRF, 413; klucz odrzucony ⇒
  502 bez treści dostawcy; brak długości ⇒ 30 s; limit minut ⇒ 429; 0 minut / brak klucza ⇒ 503),
  `lib/listen.test.ts` (koniec wypowiedzi: mowa od razu, po ciszy, trzask, głośne tło, limit 30 s; komunikaty),
  e2e `voice-fallback.spec.ts` (przeglądarka z błędem `network` → prawdziwe nagranie z generatora tonu, wykrycie
  końca, wysyłka do atrapy `/api/stt`, tekst w polu; rozmowa głosowa przez serwer z odpowiedzią na głos; stan
  w Ustawieniach; bez zapasu — konkretny komunikat, bez nagrywania). Zrzut: `docs/screens/*-23-voice-error.png`.
- Niesprawdzone: prawdziwe konto ElevenLabs (rozpoznawanie po polsku, opóźnienie) i prawdziwe przeglądarki
  Brave/Opera/Firefox z mikrofonem.

### Zmiana uprawnień połączonego konta; model wie, co jest wyłączone (2026-09-27)

- Zgłoszenie po pierwszym prawdziwym połączeniu Google: „nie mam zgody nigdzie” — wysyłka e-maili jest celowo
  domyślnie wyłączona (włączana świadomie), a po połączeniu nie dało się jej dołożyć bez odłączania konta; model
  nie dostawał narzędzia i nie wiedział dlaczego.
- Teraz: „Zmień uprawnienia” przy połączonym koncie (wybór zaczyna się od obecnych, „Zapisz uprawnienia” →
  zgoda u dostawcy, połączenie zastąpione nowym; Google dokłada zakres do przyznanych). Model dostaje listę
  funkcji kont możliwych do włączenia, a wyłączonych (tylko u skonfigurowanych dostawców), z informacją, że
  włącza się je w Ustawienia → Integracje — i nie udaje, że je wykonał.
- Testy: `model-chat.test.ts` (+2: konto tylko do odczytu — narzędzia odczytu są, wysyłki nie ma, podpowiedź
  w instrukcjach; bez skonfigurowanych integracji — bez podpowiedzi), e2e `integrations.spec.ts` (+1: „Zmień
  uprawnienia”, Anuluj, zapis z wysyłką — zakresy w adresie zgody Microsoft).
- Polecenia i wyniki: `pnpm check` → 6/6, 29/29, 298/298, web 21/21; `pnpm test:e2e` → 56/56;
  `pnpm test:prod-smoke` → 1/1.

### Plan zajęć z pliku .ics; model zna datę (2026-09-27)

- Ustawienia → Kalendarz → „Plan zajęć i kalendarze z pliku (.ics)”: wgranie (np. „Zapisz jako ical” z Wirtualnego
  Dziekanatu IDEIS), lista z liczbą wydarzeń, zakresem i najbliższymi zajęciami, „Wgraj nową wersję”, „Usuń”,
  instrukcja pobrania planu. Zajęcia w przeglądzie dnia (z salą), w zajętości i dla prywatnego asystenta
  (narzędzie `calendar.agenda`). Model dostaje bieżącą datę i godzinę w Polsce (D-035). Migracja `0018`.
- Sprawdzone: eksport planu z serwisu uczelni zwraca poprawny plik iCalendar (ical.net), ale zakres dat zależy
  od sesji przeglądarki — dlatego import pliku, nie pobieranie z adresu. Prawdziwego planu z zajęciami nie
  wgrywałem (plik z bieżącą datą był pusty; plan właściciela — do sprawdzenia przez niego).
- Testy: `calendar/ics.test.ts` (7: strefa bez definicji i zmiana czasu, nazwa strefy z Windows, czas pływający
  i UTC, cały dzień, brak końca, powtarzanie z EXDATE / przeniesieniem / odwołaniem, zawijanie linii i znaki
  ucieczki, okno i limit, błędne pliki), `calendar/imports.test.ts` (6: wgranie, przegląd dnia z salą, lista bez
  zaimportowanych, audyt bez tytułów, nowa wersja, usunięcie, izolacja Alfa/Beta, błędne pliki, 413, CSRF,
  logowanie; asystent prywatny — data w instrukcjach, narzędzie bez zgody, NovaAI bez narzędzia, Beta nie widzi
  planu Alfy), `lib/format.test.ts` (+1 odmiana liczebników), e2e `calendar-import.spec.ts`.
  Zrzut: `docs/screens/*-24-calendar-import.png`.
- Polecenia i wyniki: `pnpm check` → 6/6, 29/29, 311/311, web 22/22; `pnpm test:e2e` → 58/58;
  `pnpm test:prod-smoke` → 1/1.
- Po pierwszym prawdziwym planie (właściciel, 45 zajęć): asystent znał daty, ale nie salę — IDEIS trzyma ją
  w opisie, nie w LOCATION. Teraz sala z opisu („Sala: …”) i zwięzłe szczegóły (prowadzący, grupa) trafiają
  do planu i do asystenta; sprawdzone lokalnie na pliku właściciela (45/45 z salą), plik nie trafił do
  repozytorium — testy na zmyślonych danych w tym samym układzie (`src/calendar` → 15/15). Plan trzeba wgrać
  ponownie („Wgraj nową wersję”).
- Po pierwszym prawdziwym planie (właściciel, 45 zajęć): asystent znał daty, ale nie salę — IDEIS trzyma ją
  w opisie, nie w LOCATION. Teraz sala z opisu („Sala: …”) i zwięzłe szczegóły (prowadzący, grupa) trafiają
  do planu i do asystenta; sprawdzone lokalnie na pliku właściciela (45/45 z salą, godziny zgodne), plik nie
  trafił do repozytorium — testy na zmyślonych danych w tym samym układzie. Plan trzeba wgrać ponownie
  („Wgraj nową wersję”).

### Formatowanie odpowiedzi; sala także w planach wgranych wcześniej (2026-09-27)

- Odpowiedzi asystenta z prostym Markdownem (pogrubienie, kursywa, kod, nagłówki, listy, linki http(s)) zamiast
  gwiazdek — `lib/markdown.tsx`, tylko elementy Reacta (bez HTML z treści), także przy odsłanianiu i pisaniu
  na żywo (niedomknięte ** nie miga). Model: „formatowanie tylko proste, bez tabel”; nie wspomina o dokumentach,
  gdy pytanie ich nie dotyczy.
- Plan wgrany przed odczytem sali z opisu: sala odczytywana z zapisanych notatek („Sala: …”) w przeglądzie dnia
  i dla asystenta — bez ponownego wgrywania.
- Testy (tylko zmienione obszary): `lib/markdown.test.ts` (6), web 28/28, e2e `assistant-motion` 4/4,
  api `src/calendar` + `src/briefing` 20/20, `src/model` + `src/documents` 85/85.

### Wybór przedmiotów w planie; sala nazwana wprost (2026-09-27)

- Plan toku z IDEIS zawiera zajęcia wszystkich ścieżek i grup. Przy wgranym planie: „Przedmioty — pokazywane
  X z Y” z polami wyboru; odznaczone są ukryte w przeglądzie dnia, zajętości i u asystenta, a wybór zostaje po
  „Wgraj nową wersję” (migracja `0019`: `excluded_titles`, `hidden`; RLS jak wcześniej, tylko właściciel).
- Asystent dostawał salę bez etykiety („— F Montreal”) i nie rozpoznawał jej jako sali — teraz
  „— sala/miejsce: F Montreal” (też dla wydarzeń z Outlooka).
- Testy (zmienione obszary): api `src/calendar` + `src/briefing` + `microsoft.test.ts` 47/47, e2e
  `calendar-import` 2/2.

### Wyszukiwanie w internecie (Anthropic) (2026-09-27)

- Decyzje właściciela: Slack, Outlook uczelniany i Home Assistant — pominięte; wyszukiwanie przez Anthropic na
  tym samym kluczu. Modele AI → cennik modelu → „Wyszukiwanie w internecie — cena za 1000” włącza je dla modelu
  Claude; koszt w limicie budżetu; źródła pod odpowiedzią (D-036). Migracja `0020`.
- Testy (zmienione obszary): kontrakt adaptera (wersja narzędzia wg modelu, `pause_turn`, łączenie tekstu,
  źródła, liczba wyszukań), brama (koszt wyszukań, zasady tylko z narzędziem, bez ceny/zgody — bez narzędzia),
  zapis ceny w modelach domu; e2e `models` 4/4. Prawdziwe wyszukiwanie — niesprawdzone (atrapa API).

### Domownicy: rejestracja z zaproszenia (2026-09-27)

- Ustawienia → Domownicy: lista osób (właściciel / domownik, „zaproszony — link ważny do…”), zaproszenie
  (imię + e-mail → jednorazowy link na 7 dni do utworzenia klucza dostępu, przycisk „Kopiuj”), „Nowy link”,
  „Usuń z domu” (wylogowanie na wszystkich urządzeniach). Tylko właściciel domu zaprasza i usuwa (D-037).
- API: `GET /api/household/members`, `POST /api/household/invites`, `POST /api/household/members/:id/link`,
  `DELETE /api/household/members/:id`. Logowanie bez zmian — tylko klucz dostępu; ekran logowania mówi,
  skąd wziąć zaproszenie.
- Testy: API (zaproszenie → rejestracja klucza → własny asystent; domownik bez uprawnień; błędy 400/409;
  pełny dom; nowy link unieważnia stary; usunięcie → 401; ponowne zaproszenie), e2e desktop + telefon
  (zaproszenie w Ustawieniach, klucz na „drugim urządzeniu” z wirtualnym uwierzytelniaczem, usunięcie).

### Zestaw wdrożeniowy na VPS (2026-09-27)

- `infra/deploy/`: `setup-server.sh` (Node 22, pnpm, PostgreSQL 16, Caddy, ufw, użytkownik `novaai`, klucz
  wdrożeniowy, baza i `.env` z losowymi sekretami, usługi, build, migracje, start), `update.sh`, `admin.sh`,
  `backup.sh` + timer, `Caddyfile`, `novaai.service`, szablon `env.production`. Instrukcja krok po kroku:
  `docs/DEPLOY.md` → 5; decyzje D-038.
- Sprawdzone lokalnie: shellcheck, `caddy validate` i `caddy fmt` (Caddy 2.10.2), `systemd-analyze verify` i
  `security` (ekspozycja 3.6 OK), szablon `.env` przez parser konfiguracji aplikacji, SQL ról dwa razy z rzędu
  (idempotentny) i wszystkie migracje na świeżej bazie z tymi rolami, smoke test ścieżki produkcyjnej.
  **Nie uruchomione na prawdziwym serwerze** — uruchamia właściciel.

### Polityka prywatności i warunki (publikacja aplikacji Google, 2026-09-27)

- Publiczne strony `/privacy` i `/terms` serwowane przez API (bez logowania, CSP jak frontend), podlinkowane z
  ekranu logowania (strona główna). Polityka opisuje zakresy Google (`gmail.readonly` tylko na polecenie,
  `gmail.send` tylko po zatwierdzeniu, `calendar.freebusy`), przechowywanie (tokeny AES-256-GCM, fragmenty w
  rozmowie tylko dla właściciela), przekazywanie (Anthropic, ElevenLabs), odłączenie i oświadczenie Limited
  Use (PL + EN). Kontakt z `NOVA_CONTACT_EMAIL` (bez adresu w repozytorium). Test API + smoke test produkcji.

### Prosty widok domownika; bez panelu „Aktywność” (2026-09-29)

- Właściciel domu: pełne menu (Zadania, Usługi i koszty, Modele AI), w Ustawieniach stan usług, limit kosztów,
  skróty do modeli i usług, urządzenia, domownicy. Domownik: Czat, NovaAI (wspólne), Dom, Pamięć, Dokumenty,
  Ustawienia (integracje skonfigurowane na serwerze, kalendarz, wygląd, konto); „Zgody” tylko gdy coś czeka.
  Na telefonie domownik ma w dolnym pasku Dokumenty zamiast Zadań. Paleta poleceń bez widoków właściciela.
- Serwer: zmiana limitu kosztów modeli (`PUT /api/budget`) tylko dla właściciela (403 dla domownika); modele
  i domownicy — jak dotąd tylko właściciel. Widoki usług i zadań pod bezpośrednim adresem działają jak wcześniej.
- Usunięty panel „Aktywność” (prawa kolumna na komputerze) — układ dwukolumnowy. Poprawiony układ kart-skrótów
  w Ustawieniach (tekst i „Otwórz” w jednym wierszu).
- Testy: e2e ról (desktop + telefon), paleta poleceń domownika, 403 przy zmianie budżetu przez domownika.

### Powiadomienia push (Web Push, iPhone) (2026-09-29)

- Ustawienia → Powiadomienia: „Włącz powiadomienia na tym urządzeniu” (zgoda → subskrypcja z kluczem serwera),
  „Wyślij próbne”, „Wyłącz”; lista pozostałych urządzeń. iPhone w Safari bez ekranu głównego — instrukcja
  „Udostępnij → Do ekranu początkowego”. Wylogowanie wyłącza push na tym urządzeniu. Licznik nieprzeczytanych
  na ikonie aplikacji (Badging API).
- Serwer: każde nowe powiadomienie w aplikacji (przypomnienia, wiadomości od domowników, odnowienia usług…)
  trafia raz jako push na urządzenia tej osoby (co 4 s, najwyżej 30 min wstecz). Treść szyfrowana dla
  urządzenia (RFC 8291), podpis VAPID (klucz tworzony przy pierwszym użyciu, prywatny zaszyfrowany
  `NOVA_SECRET_KEY`, rotacja w `rotate-keys`). Tylko znane usługi push (Apple, Google, Mozilla, Microsoft) —
  bez dowolnych adresów. Wygasłe subskrypcje (404/410) usuwane. Migracja 0021.
- Testy: API z atrapą usługi push — treść odszyfrowana w teście kluczem „urządzenia”, wysyłka raz, 410,
  odrzucone adresy; e2e panelu (desktop, telefon, iPhone bez ekranu głównego). **Nie sprawdzone na
  prawdziwym iPhonie** — wymaga wdrożenia.

### Przeglądy dnia o 7:00 i 22:00, pogoda (2026-09-29)

- Automatycznie, jako powiadomienie (w aplikacji i push): rano (7:00) — co dziś, wieczorem (22:00) — co jutro:
  zajęcia i wydarzenia z salą, przypomnienia (własne i wspólne), odnowienia usług, pogoda. Raz dziennie na
  osobę (także po restarcie serwera); spóźnienie ponad 90 min — pominięty. Tylko osoby, które się logowały.
- Ustawienia → Powiadomienia → Przegląd dnia: włączenie i godzina osobno rano i wieczorem, „Podgląd”.
  Właściciel ustawia miasto prognozy (wyszukiwanie Open-Meteo); pogoda także w przeglądzie na „Dom”.
- Pogoda: Open-Meteo (bez klucza, darmowe niekomercyjnie, CC BY 4.0 — źródło w Ustawieniach), bufor 30 min.
  Polityka prywatności uzupełniona o usługi push i Open-Meteo. Migracja 0022.
- Testy: API (wieczór/rano, treść z salą, prywatność przypomnień, raz dziennie, godziny, okno 90 min, bufor
  pogody, miasto tylko właściciel), e2e ustawień przeglądu. Maile nie trafiają do przeglądu — asystent czyta
  pocztę tylko na polecenie (polityka prywatności).

### Szybkie przypomnienia z czatu i głosu (2026-09-29)

- „Przypomnij mi jutro o 8 o kolokwium” (pisane albo w rozmowie głosowej — ta sama tura asystenta) tworzy
  przypomnienie; o czasie przychodzi powiadomienie i push. Potwierdzenie z czytelną datą („środa 30 września,
  08:00 — …”). Nowe narzędzia: `reminder.list` („jakie mam przypomnienia?”) i `reminder.cancel` (tylko własne).
  W NovaAI (rozmowa wspólna) — przypomnienia wspólne.
- Terminy od modelu jako czas lokalny w Polsce bez strefy (np. 2026-09-30T08:00) — serwer liczy czas letni
  i zimowy (wcześniej model musiał znać przesunięcie strefy). Anulowanie wspólne dla API i narzędzia.
- Testy: przez model (FakeProvider): czas lokalny → właściwy UTC, lista z identyfikatorami, anulowanie tylko
  własnych; dotychczasowe testy przypomnień.

### Wspólna lista zakupów (2026-09-29)

- „Dom” → Lista zakupów: dodawanie (kilka pozycji po przecinku), odhaczanie w sklepie (od razu na ekranie),
  usuwanie, „Usuń kupione”; kto dodał — widać przy pozycji. Zmiany domownika pojawiają się na żywo
  (zdarzenie `shopping.changed`). Kupione znikają z listy po dobie.
- Asystent (czat prywatny i NovaAI, także głosem): `shopping.add` („dodaj mleko i jajka”), `shopping.list`
  („co mamy kupić?”), `shopping.check` („kupiłem mleko” — dokładna nazwa albo jedyna pasująca pozycja).
  Bez powtórzeń wśród niekupionych. Lista w przeglądzie dnia („Lista zakupów: mleko, jajka (+2)”).
- Dane: `shopping_items` z RLS — tylko członkowie domu (migracja 0023).
- Testy: API (wspólna lista, powtórzenia, odhaczanie przez domownika, zdarzenia, izolacja innego domu,
  przegląd dnia), przez model (dodaj/pokaż/odhacz), e2e (Alfa dodaje, Beta odhacza i usuwa; telefon).

### Zdjęcia w czacie (2026-09-29)

- Przycisk aparatu w polu wiadomości (na iPhonie: zrobienie zdjęcia albo wybór z galerii), do 4 zdjęć,
  miniatury przed wysłaniem. Zdjęcie jest zmniejszane w przeglądarce (1600 px, JPEG) i trafia do modelu razem
  z wiadomością — np. paragon, lodówka („co ugotować?”), pismo, zrzut ekranu. W wiadomości widać zdjęcie.
- Serwer: `chat_images` (migracja 0024) — prywatne autora do wysłania, potem widoczność rozmowy (RLS);
  format sprawdzany po nagłówku pliku (JPEG/PNG/WebP, do 4 MB); niewysłane usuwane po dobie. Model widzi
  zdjęcie tylko w turze wysłania (w historii znacznik „[zdjęcie]”) — mniejszy koszt. Anthropic: blok `image`
  (base64) przed tekstem; dostawcy zgodni z OpenAI: `image_url` z adresem `data:`. Szacunek kosztu uwzględnia
  zdjęcia. Tura ze zdjęciem jest traktowana jak treść niezaufana — akcje z niej wymagają zgody.
- Testy: kontrakt żądań (Anthropic, OpenAI), przepływ przez czat (uprawnienia, raz na wiadomość, tylko bieżąca
  tura, NovaAI — widzi domownik, zgoda dla akcji), e2e (wybór pliku, miniatura, zdjęcie w wiadomości).

### Wydatki wspólne i osobiste, raty, paragony (2026-09-29)

- Nowy widok „Wydatki” (menu i dolny pasek, dla obu osób): miesiąc (‹ ›), Wszystkie / Wspólne / Moje, suma
  i kategorie, dodawanie (kwota „45,20”, kategoria, opis, data, wspólny/osobisty), lista (kto dodał; usuwa
  autor). „Stałe płatności i raty”: nazwa, kwota, dzień miesiąca, ostatnia rata (opcjonalnie), wspólna/osobista;
  „Zapłacone” zapisuje wydatek raz w miesiącu; „zostało N”; „Zakończ”.
- Przegląd dnia przypomina o niezapłaconej płatności (wieczorem dzień wcześniej, rano w dniu terminu).
- Asystent: `expense.add` (paragon ze zdjęcia → kwota, sklep, data; w turze ze zdjęciem — zgoda z kwotą do
  sprawdzenia), `expense.summary` („ile wydaliśmy w tym miesiącu?”), `payment.add` („rata 450 zł 10-go do
  grudnia 2027”), `payment.list`, `payment.paid` („zapłaciłem ratę za telefon”). W NovaAI — tylko wspólne.
- Dane: `expenses`, `recurring_payments` z RLS (prywatne — autor, wspólne — dom; zmienia autor), migracja 0025.
  Polityka prywatności: nowe rodzaje danych. Dolny pasek na telefonie mieści 5 pozycji.
- Testy: API (widoczność, sumy, kategorie, walidacja, raty: termin, ile zostało, raz w miesiącu, wspólny czynsz
  opłacony przez domownika, zakończenie przez autora, przegląd dnia), przez model (wydatek, podsumowanie,
  rata), e2e (wspólny wydatek Bety u Alfy, rata „Zapłacone”).

### Terminy i fiszki (2026-09-29)

- „Dom” → Terminy: egzamin/kolokwium, oddanie (projekt, zlecenie — przyda się też przy pracy grafika), inny;
  data i opcjonalnie godzina, przedmiot podpowiadany z planu zajęć; „za N dni”, odhaczenie „zrobione”.
  Przegląd dnia: 3 dni wcześniej (rano), dzień przed (wieczorem) i w dniu terminu. Prywatne.
- „Dokumenty” → Fiszki: talie tworzy asystent z notatek („zrób fiszki z …” — czyta dokument i zapisuje karty),
  nauka: pytanie → „Pokaż odpowiedź” → „Umiem” / „Jeszcze nie” (metoda Leitnera: przerwy 1, 2, 4, 8, 16 dni).
  Rano w przeglądzie: „Fiszki do powtórki: N”.
- Asystent (czat prywatny): `deadline.add`, `deadline.list`, `deadline.done`, `flashcards.create`.
- Dane: `deadlines`, `flashcard_decks`, `flashcards` — tylko właściciel (RLS; karta tylko do własnej talii),
  migracja 0026.
- Testy: API (czas polski, prywatność, przeszłość odrzucona, zapowiedź 3 dni / wieczór / dzień, fiszki:
  Leitner, dopisanie do talii, prywatność, usunięcie), przez model (termin, fiszki), e2e (termin w „Dom”,
  nauka z talii).

### Propozycje do zapamiętania; zgoda w czacie (2026-09-29)

- Gdy w rozmowie padnie mimochodem trwała informacja („nie jem glutenu”, „Asia ma urodziny 12 maja”), asystent
  proponuje zapis narzędziem `memory.suggest` — najwyżej jedna propozycja na odpowiedź; zapis dopiero po zgodzie.
  `memory.create` bez zgody — tylko gdy użytkownik wprost prosi o zapamiętanie.
- Zgody z tej tury można zatwierdzić lub odrzucić wprost pod wiadomością asystenta (treść, cel, „Zatwierdź” /
  „Odrzuć”); dotyczy wszystkich akcji wymagających zgody (także wydatek z paragonu, wiadomość do domownika).
  Domownik w rozmowie wspólnej nie widzi cudzych zgód.
- Testy: przez model (propozycja → zgoda → zapis; odrzucona → brak zapisu; brak wpisu u domownika), e2e
  (karta zgody w czacie; odpowiedzi serwera podstawione w przeglądarce — e2e działa w trybie demo).

### Dodawanie wydarzeń do Kalendarza Google (2026-09-29)

- Asystent prywatny: `calendar.create` („wpisz mi w kalendarz oddanie projektu w piątek o 10”) — tytuł, czas
  lokalny w Polsce (albo cały dzień / kilka dni), miejsce, opis, opcjonalne przypomnienie. **Zawsze zgoda**
  z podglądem (karta w czacie); wydarzenie trafia do kalendarza głównego połączonego konta Google.
  Domyślny czas trwania — godzina. NovaAI (wspólny) nie ma tego narzędzia.
- Uprawnienie osobne, domyślnie wyłączone: Integracje → Google → „Dodawanie wydarzeń do Twojego kalendarza”
  (zakres `calendar.events.owned` — najwęższy pozwalający dodać wydarzenie; dokumentacja sprawdzona
  2026-09-29). Bez niego model wie, gdzie je włączyć. Polityka prywatności uzupełniona.
- Testy: kontrakt na atrapie Google (zakres w URL autoryzacji, zgoda z podglądem, treść żądania: czas polski
  z `timeZone`, całodniowe z końcem wyłącznym, domyślne przypomnienia; błędny czas i przeszłość odrzucone;
  bez uprawnienia brak narzędzia; NovaAI — odmowa). **Nie sprawdzone na prawdziwym koncie Google.**
- Tryb demo: polecenia „dodaj do kalendarza: 2026-10-05T10:00 | Tytuł” i „zaproponuj zapamiętanie: …”;
  e2e propozycji zapamiętania przechodzi teraz cały przepływ (zgoda w czacie → wpis w Pamięci).

### Skrót Siri „Zapytaj Novę” (2026-09-29)

- Ustawienia → Skrót Siri (każda osoba dla siebie): „Utwórz klucz skrótu” — klucz widoczny raz (Kopiuj),
  „Nowy klucz” (poprzedni przestaje działać), „Wyłącz”; ostatnie użycie. Instrukcja krok po kroku dla
  aplikacji Skróty: Dyktuj tekst → Pobierz zawartość URL (POST, `Authorization: Bearer <klucz>`, JSON
  `question`) → Pokaż wynik. „Hej Siri, Zapytaj Novę” — Siri czyta odpowiedź.
- Serwer: `POST /api/shortcut/ask` — tylko klucz (bez ciasteczka, więc bez nagłówka CSRF); pytanie trafia do
  prywatnej rozmowy „Siri” (ta sama przy kolejnych pytaniach, nowa po archiwizacji), tura asystenta jak w czacie,
  odpowiedź zwykłym tekstem bez formatowania (do 25 s; dłużej — „odpowiedź w aplikacji”). Akcje wymagające zgody
  czekają w aplikacji („Zgoda czeka w aplikacji NovaAI”). Model wie, że odpowiedź przeczyta Siri (krótko, bez
  list). Błędy także tekstem. Limity: 30/min na adres, 10/min na osobę. Klucz: w bazie tylko SHA-256, nieważny
  po wyłączeniu konta lub członkostwa. Migracja 0027. Polityka prywatności uzupełniona (klucz, Apple).
- Tworzenie rozmowy wydzielone do `createConversation` (czat i skrót — jedna ścieżka).
- Testy: API 5/5 (klucz widoczny raz i tylko jako skrót, zastąpienie i wyłączenie, pytanie bez ciasteczka →
  tekst, rozmowa „Siri” prywatna i ciągła, archiwizacja, zgoda czeka, odmowy tekstem, ciasteczko nie zastępuje
  klucza, limit czasu, tekst do mowy, podpowiedź w prompcie). Cały zestaw API: 349 zaliczonych, 1 niezaliczony
  tylko na Windowsie bez uprawnień do symlinków (`devices.test.ts`, EPERM — środowisko, nie kod).
  e2e `shortcut.spec.ts` (klucz z UI → pytanie jak ze Skrótów → rozmowa w czacie) napisany, **nieuruchomiony**
  (brak Chromium Playwrighta na tym komputerze). **Nie sprawdzone na prawdziwym iPhonie** — wymaga wdrożenia
  pod publicznym adresem.

### Poprawka: raty — najbliższy termin, faktyczna kwota, bez zbędnych przypomnień (2026-09-29)

- Zgłoszenie: rata dodana 29.09 na 15. dnia miała plakietkę „nie w tym miesiącu”; asystent dołożył jednorazowe
  przypomnienie i twierdził, że przypomnienia się nie powtarzają; przy zmiennej kwocie nie było jak wpisać
  faktycznej.
- Przyczyna: opis `payment.add` i jego wynik nie mówiły, że przegląd dnia przypomina co miesiąc (wieczorem dzień
  przed, rano w dniu terminu). Teraz mówią to wprost (bez `reminder.create`), a wynik podaje pierwszy termin.
- „Wydatki” → płatność pokazuje „najbliższa: 15 paź” (API: `nextDueDate`); „Zapłacone” pyta o kwotę (podpowiedź:
  zapisana). `payment.paid` i `POST /payments/:id/paid` przyjmują faktyczną kwotę. Pola formularza bez ucinania.
- Testy: API i przez model 27/27 (najbliższy termin, faktyczna kwota, treść wyniku i opisu narzędzia, pierwszy
  termin). e2e `expenses.spec.ts` zaktualizowany (okno z kwotą) — nieuruchomiony (brak Chromium lokalnie).

### Zakupy z przepisów (aniagotuje.pl); czat bez szczegółów technicznych (2026-09-30)

- Osobny ekran „Zakupy” (menu, dolny pasek na telefonie, paleta poleceń): jedna wspólna lista domu, duże pola
  do odhaczania w sklepie. Na telefonie w dolnym pasku: Czat, Dom, Zakupy, Wydatki oraz Pamięć (właściciel)
  albo Dokumenty (domownik); Zadania i pozostałe — w palecie poleceń i menu na komputerze.
- „Chcę zrobić leczo”: nowe narzędzie `recipe.find` — serwer wyszukuje przepis na aniagotuje.pl (albo bierze
  podany link) i czyta składniki z oznaczeń schema.org Recipe; woda, sól i pieprz pominięte. W turze
  uzupełniającej model proponuje listę: jedna pozycja na produkt, ilości zsumowane z tym, co już jest na liście
  (`shopping.add` z `update`: „jajka 3 szt.” → „jajka 5 szt.”). Zawsze karta zgody z całą listą (+ nowe,
  ~ zmienione). Model zna aktualną listę zakupów (kontekst), więc sumuje także przy „dodaj jajka” w innej
  rozmowie. Tura uzupełniająca dostaje narzędzia tylko wskazane przez użyte narzędzie (`followUpTools`), zawsze
  za zgodą i bez kolejnej tury.
- Czat bez „kuchni”: zamiast „Proponuję: shopping.list, payment.list.” — gdy przychodzi odpowiedź na podstawie
  wyników, same wyniki narzędzi i pusta zapowiedź są ukryte; widoczne wyniki (np. akcje zatwierdzone później)
  bez nagłówka „Wynik akcji:” i bez identyfikatorów. Model ma zasadę: bez nazw narzędzi, identyfikatorów
  i opisów działania systemu.
- Testy: API `recipes.test.ts` 3/3 (parsowanie jak na prawdziwej stronie — tekst i rozbicie `<meta>`, encje,
  wyniki wyszukiwania, tylko linki aniagotuje.pl; przepływ: lista w kontekście → przepis z atrapy serwisu →
  tura uzupełniająca tylko z listą zakupów → zgoda z całą listą → suma ilości na jednej liście; bez przepisu
  tura uzupełniająca bez narzędzi; zły link odrzucony bez połączenia). Cały zestaw API 353 zaliczonych
  (1 niezaliczony — symlinki na Windowsie bez uprawnień, jak wcześniej). e2e `shopping.spec.ts`
  i `roles.spec.ts` zaktualizowane — nieuruchomione (brak Chromium lokalnie). **Nie sprawdzone
  z prawdziwym modelem** — jakość sumowania ilości zależy od modelu.

### Spiżarnia: asystent wie, co jest w domu (2026-09-30)

- Decyzje właściciela: cały dom (lodówka, zamrażarka, szafka); bez ilości — „masz / pewnie się kończy /
  raczej nie masz”; gdy coś pewnie się skończyło — oznaczenie i propozycja (bez usuwania po cichu); danie z
  przepisu uznane za ugotowane po 3 dniach, chyba że użytkownik powie inaczej.
- „Zakupy” → Spiżarnia: pogrupowana (Lodówka, Zamrażarka, Szafka), oznaczenia stanu, „Jest”, „Na listę”
  (skończyło się + dopisanie do zakupów), „×”, dodawanie. Na start: zdjęcie lodówki w czacie („to mam”) —
  karta zgody z rozpoznaną listą — albo „mam jajka, masło…”.
- Odhaczenie na liście zakupów dodaje produkt do spiżarni (cofnięcie odhaczenia — usuwa dodany wtedy wpis).
  Stan z daty zakupu i trwałości: startowa typowa dla produktu (pieczywo 3 dni, mięso 3, nabiał 6, jajka 21,
  mąka i przyprawy 180, mrożonki 90, reszta 7), potem średnia z tym, ile rzecz faktycznie wytrzymała do
  kolejnego zakupu albo „skończyło się”.
- Asystent ma SPIŻARNIĘ w kontekście i nie pyta, czy coś jest w lodówce: „masz” pomija, „pewnie się kończy”
  daje na listę jako „Pewnie masz — sprawdź” (przyciski „Kup” / „Mam”), resztę dopisuje. Przy przepisie
  zapisuje danie (`meal`): jego składniki schodzą ze spiżarni po 3 dniach albo po „zrobiłem leczo”
  (`pantry.update`: have, gone, cooked, notCooked). Wieczorny przegląd: „Pewnie skończyło się: …”.
- Dane: `pantry_items`, `meals`, `shopping_items.maybe` (migracja 0028), RLS — członkowie domu.
- Testy: API `pantry.test.ts` 6/6 (nazwy i odmiana, trwałość, stan w czasie, izolacja domów, odhaczenie →
  spiżarnia i cofnięcie, uczenie trwałości, „pewnie masz” — Mam/Kup i przeniesienie przez inny przepis, danie
  po 3 dniach, przegląd wieczorny, asystent: kontekst i „zrobiłem leczo, mleko się skończyło”). e2e ekranu —
  brak (Chromium niedostępny lokalnie). **Nie sprawdzone z prawdziwym modelem** (rozpoznawanie ze zdjęcia,
  trafność maybe/uses).

### Połączenia pociągów i autobusów z rozkładów (2026-10-01)

- Zgłoszenie: asystent szukał połączeń Andrychów → Kraków Główny w internecie i nie podał godzin.
- Nowe narzędzie `transit.search` (zamiast wyszukiwania w internecie): serwer pobiera rozkłady GTFS — pociągi
  wszystkich przewoźników (`polish_trains.zip`, mkuran.pl z PKP PLK „Otwarte Dane Kolejowe”, codziennie,
  ok. 30 dni naprzód) i autobusy Kolei Małopolskich (`ald-gtfs.zip`, m.in. A40 Andrychów ↔ Kraków MDA) —
  i sam wyszukuje połączenia (Connection Scan): przesiadki (min. 4 min), przejścia piesze między pobliskimi
  przystankami (np. Kraków MDA ↔ Kraków Główny), dni kursowania, zakazy wsiadania/wysiadania, kursy po północy.
  Tryby: odjazd od godziny albo „przyjazd do” (np. zajęcia o 10:00). Dziś — opóźnienia i odwołania pociągów
  na żywo (najwyżej sprzed 2 min). Wynik: godziny, czas, przesiadki, przewoźnik i numer, peron/tor.
- Nazwy bez polskich znaków; „Kraków” → Kraków Główny, „Andrychów” → stacja i przystanki w mieście.
  Nieznana nazwa → podpowiedzi zamiast zgadywania. Rozkłady pobierane przy pierwszym pytaniu (ok. 31 MB,
  wczytanie ~1 s), odświeżane co 20 h; pamięć ok. 120 MB.
- Sprawdzone na prawdziwych danych (2 października): Andrychów → Kraków Główny 06:28 → 07:46 i 07:18 →
  09:11, Kraków Główny → Andrychów 15:56 → 19:05 — zgodnie z KOLEO; do tego autobusy KM (np. 05:52 →
  07:41 z dojściem z MDA), których KOLEO dla stacji nie pokazuje. Prywatni przewoźnicy busów — nie ma ich w
  otwartych danych.
- Testy: `transit.test.ts` 5/5 (czytnik ZIP i GTFS, nazwy, autobus + dojście wygrywa z przesiadką, kurs
  odwołany w danym dniu pominięty, przesiadka w Kalwarii, „przyjazd do”, opóźnienie na żywo, przez asystenta).

### Poprawka: powiadomienia push na iPhonie (aplikacja z ekranu głównego) (2026-10-02)

- Zgłoszenie: brak powiadomień na iPhonie (NovaAI dodana do ekranu głównego, nie z App Store).
- Włączenie czeka na aktywny service worker (`navigator.serviceWorker.ready`, do 10 s) — pierwsze otwarcie
  z ekranu głównego ma osobną pamięć, worker dopiero się instaluje i subskrypcja kończyła się błędem. Brak
  rejestracji w zbudowanej aplikacji → rejestracja na miejscu. Instalacja workera nie przerywa się już przy
  błędzie buforowania powłoki (słaby zasięg) — wcześniej oznaczało to brak workera, a więc brak push.
- Przy każdym starcie aplikacji urządzenie z włączonymi powiadomieniami (ta sama osoba, zgoda systemowa)
  sprawdza, czy serwer zna jego subskrypcję; jeśli nie (usunięta po błędach, iPhone wymienił ją, nowy klucz
  serwera) — zgłasza ją ponownie bez pytania o zgodę. Wyłączenie i wylogowanie — bez ponownego zgłaszania.
- Dom: karta „Powiadomienia na tym urządzeniu” z przyciskiem „Włącz powiadomienia”, gdy urządzenie obsługuje
  push, a osoba jeszcze nie odpowiedziała na pytanie o zgodę („Nie teraz” ukrywa ją na stałe). iPad
  (przedstawia się jako Mac) rozpoznawany jako iPadOS — w Safari dostaje instrukcję dodania do ekranu głównego.
- Serwer zapisuje w dzienniku powód odrzucenia przez usługę push (np. Apple `BadJwtToken`):
  `journalctl -u novaai | grep '\[push\]'`.
- Testy: `push.test.ts` (rozpoznanie iPhone/iPad), e2e zachęty na ekranie Dom. Nadal **niesprawdzone na
  prawdziwym iPhonie** — wymaga wdrożenia.

### Poprawka: „Oznacz jako przeczytane” od razu zmniejsza liczniki (2026-10-03)

- Zgłoszenie: po „Oznacz jako przeczytane” na ekranie Dom licznik nieprzeczytanych nie znikał do ponownego
  otwarcia aplikacji.
- Przyczyna: odświeżała się tylko lista wiadomości; liczniki (menu „Dom”, „Nieprzeczytane” w przeglądzie dnia,
  liczba na ikonie aplikacji) reagowały wyłącznie na nowe powiadomienia.
- Serwer po odczycie wysyła zdarzenie `notification.read` (prywatne, tylko do tej osoby) — liczniki odświeżają
  się od razu, także na innych urządzeniach tej osoby. Wiadomość od razu oznaczona w liście (bez czekania na
  serwer); błąd przywraca stan z serwera.
- Testy: API (zdarzenie tylko dla właściciela i tylko raz; domownik nie oznaczy cudzej wiadomości), e2e
  przypomnień rozszerzone o odczyt — liczniki maleją bez przeładowania (bez poprawki test nie przechodzi).
  Naprawione niejednoznaczne lokatory w tym teście („Termin”, „Dodaj” — od czasu panelu „Terminy”).

### Taniej: pamięć podręczna zapytań do Claude (prompt caching) (2026-10-03)

- Zgłoszenie: koszt modeli za wysoki (ok. 0,03–0,19 zł za wiadomość); subskrypcja Claude/ChatGPT/Gemini nie
  może zastąpić API (warunki dostawców) — zostajemy przy API Claude, ale oszczędniej.
- Dotąd każde zapytanie szło w pełnej cenie: godzina („Teraz: …”) na początku promptu systemowego zmieniała
  go co minutę, więc nic nie dało się odczytać z pamięci podręcznej.
- Teraz: prompt systemowy stały w rozmowie (instrukcje, pamięć); godzina, lista zakupów, spiżarnia i
  dokumenty — w bloku na początku ostatniej wiadomości (TERAZ, LISTA ZAKUPÓW, SPIŻARNIA, DOKUMENTY).
  Anthropic: znacznik `cache_control` na końcu promptu systemowego (obejmuje narzędzia) i na końcu historii —
  kolejna tura odczytuje całą wcześniejszą rozmowę po ok. 0,1× (Opus 5.5: 0,05×) ceny wejścia, zapis 1,25×.
  Okno historii (20 wiadomości) przesuwa się skokami co 10, żeby początek rozmowy nie zmieniał się w każdej
  turze. Ten sam układ pomaga automatycznej pamięci podręcznej OpenAI/Gemini.
- Budżet: cennik bez cen cache — dla Anthropic zapis 1,25×, odczyt 0,1× ceny wejścia (szacunek z góry);
  ceny wpisane w cenniku mają pierwszeństwo.
- Testy: kontrakt Anthropic (dokładnie 2 znaczniki: system i koniec historii), trzy tury tej samej rozmowy —
  identyczny prompt systemowy i początek historii mimo zmiany listy zakupów, koszt z tokenami cache, okno
  historii. Niesprawdzone na prawdziwym koncie — po wdrożeniu widać w koszcie odpowiedzi.

### „Ustaw oszczędnie”: Haiku 4.5 do krótkich pytań, Sonnet 5.5 do złożonych (2026-10-03)

- Modele AI i klucze API → sekcja Modele: panel „Oszczędny zestaw Claude” (gdy jest dostawca Anthropic — z
  aplikacji albo klucz z serwera). Przycisk „Ustaw oszczędnie” dodaje (albo aktualizuje) Claude Haiku 4.5 —
  „krótkie pytania”, priorytet 1 — i Claude Sonnet 5.5 — „złożone zadania i długie rozmowy”, priorytet 2.
  Dotychczasowe modele zostają zapasowe (dalej na trasie). Formularz „Dodaj model” dla dostawcy Claude ma
  gotowe ustawienia: Haiku 4.5, Sonnet 5.5, Opus 5.5.
- Ceny (USD za mln tokenów, cennik Anthropic sprawdzony 2026-10-03): Haiku 4.5 1 / 5 (cache: odczyt 0,10,
  zapis 1,25), Sonnet 5.5 2 / 10 (0,20 / 2,50), Opus 5.5 4 / 20 (0,20 / 5); wyszukiwanie 10 za 1000
  (`CLAUDE_MODEL_PRESETS` w `@nova/contracts`). Modele w USD wymagają kursu USD→PLN.
- Test e2e: przycisk, ceny i zastosowanie obu modeli, tryb demo bez kursu, gotowe ustawienia w formularzu;
  sprzątanie przez API także po błędzie.

## Blokady

- Brak demona Docker w sesji zdalnej — `infra/compose.yaml` nieprzetestowany tutaj (używany lokalny klaster).
- Brak systemu Windows w sesji: Worker Rust sprawdzony na Linuksie (testy + interop z API) i kompilacyjnie dla
  `x86_64-pc-windows-gnu` (bez TLS — brak kompilatora mingw; nie instalowałem pakietów systemowych). Test ręczny:
  `workers/windows/README.md`.
- Brak kont OAuth (Microsoft, Slack) — te integracje sprawdzone wyłącznie na lokalnych atrapach; połączenie
  z Microsoft i Slackiem NIE jest sprawdzone. Google: właściciel połączył konto lokalnie i potwierdził odczyt poczty
  (2026-09-27; `docs/DEPLOY.md`) oraz wysyłkę po zatwierdzeniu; zajętość w kalendarzu — niesprawdzona. Google: klient OAuth „Web application”, redirect
  `<NOVA_PUBLIC_URL>/api/connections/google/callback`, `GOOGLE_CLIENT_ID/SECRET`, weryfikacja zakresów Gmail przez
  Google przed udostępnieniem. Microsoft: rejestracja aplikacji w Microsoft Entra (README → Integracje),
  `MICROSOFT_CLIENT_ID/SECRET`, `MICROSOFT_TENANT`. Slack: aplikacja wewnętrzna z zakresami użytkownika, redirect
  HTTPS, Event Subscriptions (README → Integracje), `SLACK_CLIENT_ID/SECRET`, `SLACK_SIGNING_SECRET`.
  Wszystkie wymagają `NOVA_SECRET_KEY`.
- Brak kluczy administracyjnych Anthropic/OpenAI — adaptery raportów kosztów sprawdzone tylko na atrapie
  (`ANTHROPIC_ADMIN_API_KEY`, `OPENAI_ADMIN_API_KEY`; Admin API Anthropic niedostępne dla kont indywidualnych).
- Brak kluczy API i instalacji Hermesa — adaptery modeli nie były uruchomione przeciwko prawdziwym usługom
  (świadomie: zakaz płatnych wywołań). Ceny modeli do uzupełnienia przez właściciela z oficjalnego cennika.
  Dostawcy dodawani w aplikacji (Modele AI i klucze API) sprawdzeni tylko na lokalnej atrapie.

## Niezaimplementowane (poza blokadami)

- Adapter Honcho dla `episodic`; wyszukiwanie semantyczne (embeddingi) i OCR skanów w pamięci dokumentów.
- Worker: procesy, uruchamianie aplikacji, brokerowane komendy / PowerShell, przeglądarka, zrzuty ekranu, UI Automation
  (spec, sekcja 6, punkty 4–5). Zaimplementowane: pliki (lista/odczyt/zapis z diffem i kopią) oraz git status/diff.
- Microsoft Teams (wymaga zgody administratora organizacji — `ChannelMessage.Read.All`; czaty tylko konta służbowe),
  Google Drive; subskrypcje zmian Graph/Gmail, załączniki. Slack: powiadomienia o nowych wzmiankach w czasie
  rzeczywistym (wymagałyby zakresów `*:history`), wysyłka do rozmów bezpośrednich, pliki, Enterprise Grid.
- Transkrypcja głosu po stronie serwera. Web Push nie sprawdzony na prawdziwym iPhonie (tylko atrapa usługi push).
- Zapis w kalendarzu Outlook; zmiana i usuwanie wydarzeń Google; odczyt wydarzeń Google w przeglądzie dnia
  (jest: dodawanie do Kalendarza Google po zgodzie, zajętość z grantem, wydarzenia Outlook dla agenta
  prywatnego, kalendarz lokalny).

## Następne 3 zadania

1. Uruchomienie z prawdziwymi usługami przez właściciela: klucz modelu + cennik w „Modele AI i klucze API”
   (albo `models.local.json`), limit w „Koszt modeli”, klienci OAuth
   Google i Microsoft, aplikacja Slack, klucze administracyjne raportów kosztów (README → Integracje) i sprawdzenie na
   własnych kontach; Worker na Windows.
2. Wdrożenie przez właściciela na `novaai.pl` według `docs/DEPLOY.md` → 5 (zestaw `infra/deploy/`); potem
   wpisanie VPS, domeny i planów usług z kosztami w „Usługi i koszty”.
3. Poczta, Slack i dokumenty z prawdziwym modelem: ocena odporności na wstrzyknięcia i jakości odpowiedzi; potem
   Web Push (VAPID) i ewentualnie automatyczna synchronizacja raportów kosztów w tle.
