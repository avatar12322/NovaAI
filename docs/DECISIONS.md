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
