# Postęp prac NovaAI

Aktualizowane po każdej pionowej funkcji. Tylko fakty potwierdzone poleceniami w tej sesji.

## Status etapów

| Etap                     | Status      | Uwagi                                                                |
| ------------------------ | ----------- | -------------------------------------------------------------------- |
| M0 — szkielet            | gotowe      | workspace, API, web, Postgres lokalny/Compose, migracje, healthcheck |
| M1 — izolacja            | w toku      |                                                                      |
| M2 — UI i zadania        | niewykonane |                                                                      |
| M3 — model i pamięć      | niewykonane |                                                                      |
| M4 — Worker              | niewykonane |                                                                      |
| M5 — integracje          | niewykonane |                                                                      |
| M6 — głos i proaktywność | niewykonane |                                                                      |

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

## Blokady

- Brak demona Docker w sesji zdalnej — `infra/compose.yaml` nieprzetestowany tutaj (używany lokalny klaster).
- Brak systemu Windows w sesji: Worker Rust sprawdzony na Linuksie (testy + interop z API) i kompilacyjnie dla
  `x86_64-pc-windows-gnu` (bez TLS — brak kompilatora mingw; nie instalowałem pakietów systemowych). Test ręczny:
  `workers/windows/README.md`.
- Brak kluczy API i instalacji Hermesa — adaptery modeli nie były uruchomione przeciwko prawdziwym usługom
  (świadomie: zakaz płatnych wywołań). Ceny modeli do uzupełnienia przez właściciela z oficjalnego cennika.

## Następne 3 zadania

1. M5: kontrakt Connector, szyfrowanie tokenów (AES-256-GCM + rotacja), stan „not configured”, OAuth PKCE (Google) bez realnych kluczy.
2. M5: webhooki/push z weryfikacją nadawcy, deduplikacją i odnawianiem subskrypcji; free/busy grant dla NovaAI.
3. M6: deterministyczne przypomnienia i bezpieczne powiadomienia (priorytet prywatności i budżetu).
