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
# Baza — wariant B (Docker Desktop, np. Windows): najpierw NOVA_PG_SUPERUSER_PASSWORD w .env
docker compose --env-file .env -f infra/compose.yaml up -d

pnpm db:seed                    # migracje + 2 sztuczne konta testowe (tylko dev/test)
pnpm dev                        # API http://127.0.0.1:4000, web http://127.0.0.1:5173
```

Healthcheck: `curl http://127.0.0.1:4000/api/health`.

## Produkcja: pierwsze uruchomienie (bez kont testowych)

```bash
# .env: NOVA_ENV=production, NOVA_DEV_LOGIN=false, NOVA_SECRET_KEY=<32 bajty base64>,
#       NOVA_WEB_ORIGIN=https://twoja-domena, NOVA_RP_ID=twoja-domena, NOVA_WEB_DIST=apps/web/dist,
#       NOVA_TRUST_PROXY=1 (za reverse proxy), własne hasła ról Postgres
pnpm install
pnpm build:prod                 # apps/web/dist + apps/api/dist (bundel esbuild, czysty Node — bez tsx)
pnpm --filter @nova/api admin:prod migrate
pnpm --filter @nova/api admin:prod create-household "Nasz dom" osoba1@example.com:Imię1 osoba2@example.com:Imię2
pnpm --filter @nova/api admin:prod enroll osoba1@example.com   # jednorazowy link (15 min) do rejestracji passkey
pnpm --filter @nova/api start:prod                             # API + frontend z jednego originu
```

Serwer musi działać za TLS (reverse proxy przekazujący cały ruch na `NOVA_API_HOST:NOVA_API_PORT`);
ciasteczka sesji mają wtedy flagę `Secure`. Frontend jest serwowany przez API z nagłówkiem CSP
(tylko własne skrypty i połączenia). `NOVA_TRUST_PROXY=1` (liczba zaufanych przeskoków) sprawia,
że limity żądań widzą adres klienta, a nie proxy. Smoke test całej ścieżki produkcyjnej lokalnie:
`pnpm test:prod-smoke` (baza `nova_e2e`, `NOVA_ENV=production`, wirtualny uwierzytelniacz Chromium).

## Kontrole

```bash
pnpm typecheck      # tsc we wszystkich pakietach
pnpm lint           # eslint
pnpm format:check   # prettier
pnpm test           # vitest: jednostkowe + integracyjne API na bazie nova_test (wymaga Postgresa)
pnpm check          # wszystko powyżej
```

Testy integracyjne API czyszczą i migrują od zera bazę `nova_test` (ochrona: tylko nazwy `*_test`).

E2E (Playwright, desktop 1360×860 + Pixel 7):

```bash
pnpm db:start                          # Postgres musi działać (init.sql tworzy też nova_e2e)
pnpm test:e2e                          # startuje API na :4100 (baza nova_e2e, reset) i Vite na :5174
E2E_SCREENSHOTS=1 pnpm test:e2e        # dodatkowo odświeża zrzuty w docs/screens
```

Chromium: w środowisku z preinstalowanymi przeglądarkami (`PLAYWRIGHT_BROWSERS_PATH`) nic nie trzeba;
lokalnie jednorazowo `pnpm --filter @nova/web exec playwright install chromium`.

## Jak używać (dev)

1. Otwórz http://localhost:5173 (passkeys wymagają domeny, nie IP) i wybierz konto testowe (Alfa lub Beta — sztuczne konta, tylko dev).
2. **Czat** — prywatna rozmowa z asystentem; **NovaAI** — rozmowa wspólna. Bez skonfigurowanego modelu
   odpowiada deterministyczny tryb demo (oznaczony „demo”). Komendy demo: `zapamiętaj: …`, `co pamiętasz?`,
   `napisz do domownika: …` (utworzy zgodę).
3. **Zadania** — „Zadanie demonstracyjne” pokazuje postęp, kroki równoległe i zgodę na wysyłkę wiadomości.
4. **Zgody** — podgląd dokładnej treści i odbiorcy; zatwierdzenie konkretnej wersji.
5. **Pamięć** — wpisy prywatne/wspólne, `Udostępnij` / `Cofnij udostępnienie`. **Dokumenty** (Pamięć → Dokumenty):
   dodaj PDF, TXT lub Markdown (do 10 MB), poczekaj na status „gotowy” i zapytaj w czacie — odpowiedź pokaże
   „Źródła” z nazwą dokumentu i stroną/fragmentem. Prywatny dokument widzisz tylko Ty; wspólny — domownicy i NovaAI.
6. **Dom** — wiadomości od domownika, aktywne wspólne zadania. **Ustawienia** — stan usług, budżet, motyw,
   integracje (połącz / odłącz konto, wybór uprawnień).
7. Po połączeniu konta pocztowego (tryb demo): `szukaj maili: faktura`, `przeczytaj maila: <id>`,
   `wyślij mail do adres@example.test: Temat | Treść`, `szkic maila do adres@example.test: Temat | Treść` (Outlook),
   `wydarzenia: 2026-10-01T00:00:00Z 2026-10-08T00:00:00Z`, `zajętość: <od> <do>`. Słowo `outlook` lub `gmail`
   po poleceniu wskazuje konto, gdy połączone są oba (np. `szukaj maili outlook: faktura`). Wysyłka i szkic zawsze
   czekają na zgodę w **Zgodach**.
8. Po połączeniu Slacka (tryb demo): `wzmianki slack` (albo `wzmianki slack: 14` — liczba dni),
   `szukaj na slacku: rachunek`, `napisz na slacku do C0123ABCD: treść`,
   `odpowiedz na slacku w C0123ABCD 1758790400.000500: treść`. Treść ze Slacka pokazuje przycisk „Pokaż na żywo” —
   NovaAI jej nie zapisuje. Wysyłka zawsze czeka na zgodę.
9. **Usługi i koszty** (menu boczne; na telefonie: Ustawienia → Usługi i koszty) — lista usług NovaAI (modele API,
   VPS, bazy, domeny, kopie zapasowe, abonamenty) z budżetem, datą odnowienia (przypomnienie) i linkiem do panelu;
   wpisy kosztów: szacunek, raport dostawcy, faktura (ręcznie lub import CSV). Suma miesiąca liczy każdą opłatę raz
   (faktura > raport > szacunek), osobno dla każdej waluty. Bez haseł i kluczy API.

## Integracje (opcjonalnie, własne konta)

Bez konfiguracji integracje są oznaczone jako „niedostępne”. Wymagany jest też `NOVA_SECRET_KEY` (szyfrowanie
tokenów). Każdy użytkownik łączy własne konto w Ustawieniach; NovaAI nie widzi cudzej poczty.

**Microsoft (Outlook: poczta i kalendarz)** — rejestracja aplikacji w centrum administracyjnym Microsoft Entra
(App registrations → New registration):

1. Obsługiwane konta: „dowolny katalog organizacji i osobiste konta Microsoft” (dla `MICROSOFT_TENANT=common`)
   albo tylko Twoja organizacja (wtedy `MICROSOFT_TENANT=<ID dzierżawy>`).
2. Redirect URI, platforma **Web**: `<NOVA_PUBLIC_URL>/api/connections/microsoft/callback`
   (lokalnie: `http://localhost:5173/api/connections/microsoft/callback`).
3. Certificates & secrets → nowy sekret klienta → `MICROSOFT_CLIENT_SECRET` (ma datę ważności — odnów przed nią);
   Application (client) ID → `MICROSOFT_CLIENT_ID`.
4. API permissions → Microsoft Graph → Delegated: `Mail.ReadBasic`, `Mail.Read`, `Mail.Send`, `Calendars.ReadBasic`,
   `offline_access`, `openid`, `profile`; `Mail.ReadWrite` tylko jeśli chcesz szkice w Outlooku. Aplikacja i tak
   prosi tylko o uprawnienia zaznaczone przez użytkownika przy łączeniu.

**Raporty kosztów (Usługi i koszty)** — opcjonalne klucze administracyjne tylko do odczytu kosztów organizacji:
`ANTHROPIC_ADMIN_API_KEY` (Claude Console → Admin keys; niedostępne dla kont indywidualnych) i
`OPENAI_ADMIN_API_KEY`. Bez nich adaptery są „niepodłączone”, a koszty wpisuje się ręcznie. Po ustawieniu klucza
przypisz adapter do usługi i użyj „Synchronizuj raport” — dopiero udana synchronizacja zmienia stan na „podłączone”.

**Slack** — aplikacja w api.slack.com/apps utworzona w Twoim workspace (aplikacja wewnętrzna — wyszukiwanie dla
aplikacji działa tylko dla aplikacji wewnętrznych lub opublikowanych w Slack Marketplace):

1. OAuth & Permissions → Redirect URLs: `<NOVA_PUBLIC_URL>/api/connections/slack/callback` (wymagany HTTPS —
   lokalnie przez tunel). **User Token Scopes** (nie Bot): `search:read.public`, opcjonalnie `search:read.private`,
   `search:read.im`, `search:read.mpim`, a do wysyłki `chat:write`, `channels:read`, `groups:read`.
2. Basic Information → Client ID, Client Secret, Signing Secret → `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`,
   `SLACK_SIGNING_SECRET`. Nie włączaj PKCE (zmienia aplikację w klienta publicznego, nieodwracalnie).
3. Event Subscriptions → Request URL `<NOVA_PUBLIC_URL>/api/webhooks/slack`, zdarzenia aplikacji: `tokens_revoked`,
   `app_uninstalled` (NovaAI oznacza wtedy połączenie jako „dostęp cofnięty”).

W organizacji administrator może wymagać zatwierdzenia aplikacji (wtedy Microsoft pokazuje prośbę o zgodę
administratora, a Slack — prośbę o zatwierdzenie instalacji). Teams nie jest zaimplementowany — wymaga zgody administratora (`ChannelMessage.Read.All`) i kont
służbowych. Szczegóły, endpointy i ograniczenia: `docs/DECISIONS.md` (D-019 Google, D-027 Microsoft, D-028 Slack, D-029 Usługi i koszty).

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
