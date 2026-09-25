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

## Blokady

- Brak demona Docker w sesji zdalnej — `infra/compose.yaml` nieprzetestowany tutaj (używany lokalny klaster).

## Następne 3 zadania

1. M2: trwała kolejka zadań (lease/heartbeat/próby/odzysk) + kroki + zdarzenia SSE.
2. M2: zgody z zamrożoną akcją i idempotentnym wykonaniem; tury czatu przez kolejkę.
3. M2: UI PWA (logowanie dev, czat prywatny/wspólny, zadania + Activity Strip, zgody, pamięć, ustawienia).
