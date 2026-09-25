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

## Blokady

- Brak demona Docker w sesji zdalnej — `infra/compose.yaml` nieprzetestowany tutaj (używany lokalny klaster).

## Następne 3 zadania

1. M3: ModelGateway + konfiguracja routingu, adapter Anthropic (SDK) i OpenAI-compatible (Hermes), testy kontraktowe na mocku.
2. M3: budżet (usage_records, budgets, blokada płatnych wywołań), `GET/PUT /api/budget`, `GET /api/model/status`.
3. M4: protokół Workera, parowanie, symulator, rdzeń Rust.
