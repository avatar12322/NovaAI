# NovaAI

Prywatna aplikacja asystenta dla dwóch osób: prywatny agent każdej osoby, jawna przestrzeń wspólna
(NovaAI), zadania ze zgodami, kontrola kosztów. Specyfikacja: [`docs/MASTER_SPEC.md`](docs/MASTER_SPEC.md).
Stan prac: [`docs/PROGRESS.md`](docs/PROGRESS.md). Decyzje: [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Wymagania

- Node.js ≥ 22.12, pnpm 10 (`corepack enable`)
- PostgreSQL 16: lokalny (`scripts/pg-local.sh`, Linux/macOS) **albo** Docker (`infra/compose.yaml`)
- Opcjonalnie Rust ≥ 1.80 dla `workers/windows`

## Uruchomienie (świeży checkout)

```bash
pnpm install
cp .env.example .env            # wartości domyślne pasują do lokalnego Postgresa dev

# Baza — wariant A (Linux/macOS, bez Dockera):
pnpm db:start                   # klaster w ./.data/pg na 127.0.0.1:54329 + role/bazy z infra/db/init.sql
# Baza — wariant B (Docker Desktop, np. Windows):
docker compose -f infra/compose.yaml up -d

pnpm db:seed                    # migracje + 2 sztuczne konta testowe (tylko dev/test)
pnpm dev                        # API http://127.0.0.1:4000, web http://127.0.0.1:5173
```

Healthcheck: `curl http://127.0.0.1:4000/api/health`.

## Kontrole

```bash
pnpm typecheck      # tsc we wszystkich pakietach
pnpm lint           # eslint
pnpm format:check   # prettier
pnpm test           # vitest: jednostkowe + integracyjne API na bazie nova_test (wymaga Postgresa)
pnpm check          # wszystko powyżej
```

Testy integracyjne API czyszczą i migrują od zera bazę `nova_test` (ochrona: tylko nazwy `*_test`).

## Struktura

```text
apps/api/             API Fastify: sesje, ACL, rozmowy, pamięć (kolejne moduły w PROGRESS)
apps/web/             PWA (Vite + React)
packages/contracts/   schematy zod współdzielone przez API i web
packages/permissions/ polityka dostępu (domyślna odmowa) + testy macierzy
packages/ui/          tokeny wizualne (CSS)
workers/windows/      Worker (Rust) — patrz PROGRESS
infra/                migracje SQL, init ról, Compose
docs/                 specyfikacja, decyzje, postęp
```
