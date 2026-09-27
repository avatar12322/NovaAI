#!/usr/bin/env bash
# shellcheck disable=SC1111  # polskie cudzysłowy „…” w komunikatach są zamierzone
# Pierwsza instalacja NovaAI na czystym Ubuntu 24.04 (VPS novaai.pl). Uruchamia właściciel na serwerze:
#   sudo bash setup-server.sh
# Idempotentny: można uruchomić ponownie (np. po dodaniu klucza wdrożeniowego w GitHubie) — kończy to,
# czego brakuje. Sekrety (hasła ról Postgres, klucz szyfrowania) generuje na serwerze i zapisuje tylko
# w /opt/novaai/app/.env (0600) — niczego nie wypisuje. Kroki i dalsze czynności: docs/DEPLOY.md.
set -euo pipefail

DOMAIN=novaai.pl
REPO=git@github.com:avatar12322/NovaAI.git
BRANCH=${NOVA_BRANCH:-claude/novaai-jarvis-ui}
APP_USER=novaai
BASE=/opt/novaai
APP=$BASE/app
NODE_MAJOR=22
PNPM_VERSION=10.33.0
# Klucz hosta github.com (docs.github.com → „GitHub's SSH key fingerprints”, SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU).
GITHUB_HOST_KEY='github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
validate_caddy() {
  local out
  if ! out=$(caddy validate --adapter caddyfile --config "$APP/infra/deploy/Caddyfile" 2>&1); then
    echo "$out" >&2
    return 1
  fi
}
as_app() { (cd "${WORKDIR:-$BASE}" && sudo -u "$APP_USER" -H "$@"); }

main() {
  if [[ $EUID -ne 0 ]]; then
    echo "Uruchom przez sudo: sudo bash $0" >&2
    exit 1
  fi
  # shellcheck source=/dev/null
  . /etc/os-release
  if [[ ${ID:-} != ubuntu ]]; then
    echo "Skrypt jest przygotowany dla Ubuntu 24.04 (wykryto: ${PRETTY_NAME:-nieznany})." >&2
    exit 1
  fi
  export DEBIAN_FRONTEND=noninteractive
  # needrestart (Ubuntu) restartuje usługi po aktualizacji bibliotek bez pytania.
  export NEEDRESTART_MODE=a

  step "Pakiety systemowe (git, PostgreSQL, zapora)"
  apt-get update -q
  apt-get install -y -q curl ca-certificates gnupg git openssl ufw postgresql \
    debian-keyring debian-archive-keyring apt-transport-https
  timedatectl set-timezone Europe/Warsaw || true

  step "Node.js $NODE_MAJOR (NodeSource) i pnpm $PNPM_VERSION"
  if ! node -v 2>/dev/null | grep -q "^v$NODE_MAJOR\."; then
    curl -fsSL "https://deb.nodesource.com/setup_$NODE_MAJOR.x" -o /tmp/nodesource_setup.sh
    bash /tmp/nodesource_setup.sh
    rm -f /tmp/nodesource_setup.sh
    apt-get install -y -q nodejs
  fi
  if [[ $(pnpm -v 2>/dev/null || true) != "$PNPM_VERSION" ]]; then
    npm install -g --no-fund --no-audit "pnpm@$PNPM_VERSION"
  fi
  echo "node $(node -v), pnpm $(pnpm -v)"

  step "Caddy (HTTPS, oficjalne repozytorium)"
  if ! command -v caddy >/dev/null; then
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
      gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      >/etc/apt/sources.list.d/caddy-stable.list
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q
    apt-get install -y -q caddy
  fi
  caddy version

  step "Zapora: SSH, HTTP, HTTPS"
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
  ufw --force enable >/dev/null
  ufw status | sed -n '1,12p'

  step "Użytkownik systemowy $APP_USER ($BASE)"
  if ! id "$APP_USER" >/dev/null 2>&1; then
    useradd --system --create-home --home-dir "$BASE" --shell /usr/sbin/nologin "$APP_USER"
  fi
  chmod 750 "$BASE"

  step "Dostęp do repozytorium (klucz wdrożeniowy tylko do odczytu)"
  install -d -m 700 -o "$APP_USER" -g "$APP_USER" "$BASE/.ssh"
  if [[ ! -f $BASE/.ssh/id_ed25519 ]]; then
    as_app ssh-keygen -q -t ed25519 -N '' -C "novaai-deploy@$DOMAIN" -f "$BASE/.ssh/id_ed25519"
  fi
  if ! grep -qF "$GITHUB_HOST_KEY" "$BASE/.ssh/known_hosts" 2>/dev/null; then
    echo "$GITHUB_HOST_KEY" >>"$BASE/.ssh/known_hosts"
    chown "$APP_USER:$APP_USER" "$BASE/.ssh/known_hosts"
    chmod 644 "$BASE/.ssh/known_hosts"
  fi
  local git_err
  if ! git_err=$(as_app git ls-remote --exit-code --heads "$REPO" "$BRANCH" 2>&1 >/dev/null); then
    cat <<EOF

git: ${git_err:-brak gałęzi $BRANCH}

Serwer nie ma jeszcze dostępu do repozytorium. Dodaj klucz wdrożeniowy (to klucz PUBLICZNY — można go
bezpiecznie skopiować):

$(cat "$BASE/.ssh/id_ed25519.pub")

GitHub → repozytorium NovaAI → Settings → Deploy keys → Add deploy key: tytuł „VPS novaai.pl”,
wklej powyższą linię, NIE zaznaczaj „Allow write access” → Add key. Potem uruchom ponownie:
  sudo bash $0
EOF
    exit 2
  fi

  step "Kod aplikacji ($BRANCH)"
  if [[ ! -d $APP/.git ]]; then
    as_app git clone --quiet --branch "$BRANCH" "$REPO" "$APP"
  fi
  as_app git -C "$APP" log --oneline -1

  step "Baza danych PostgreSQL (role nova_owner i nova_app, baza novaai)"
  if [[ ! -f $APP/.env ]]; then
    local app_pw owner_pw secret
    app_pw=$(openssl rand -hex 24)
    owner_pw=$(openssl rand -hex 24)
    secret=$(openssl rand -base64 32)
    install -m 600 -o "$APP_USER" -g "$APP_USER" "$APP/infra/deploy/env.production" "$APP/.env"
    sed -i \
      -e "s|@APP_DB_PASSWORD@|$app_pw|" \
      -e "s|@OWNER_DB_PASSWORD@|$owner_pw|" \
      -e "s|@SECRET_KEY@|$secret|" \
      "$APP/.env"
    echo "Utworzono $APP/.env z nowymi hasłami i kluczem (nie są wypisywane)."
  fi
  local app_pw owner_pw
  app_pw=$(sed -n 's|^DATABASE_URL_APP=postgres://nova_app:\([^@]*\)@.*|\1|p' "$APP/.env")
  owner_pw=$(sed -n 's|^DATABASE_URL_OWNER=postgres://nova_owner:\([^@]*\)@.*|\1|p' "$APP/.env")
  if [[ -z $app_pw || -z $owner_pw ]]; then
    echo "W $APP/.env brakuje DATABASE_URL_APP/DATABASE_URL_OWNER (postgres://rola:hasło@…)." >&2
    exit 1
  fi
  # Hasła przez stdin (nie w argumentach procesu); role jak w infra/db/init.sql, bez haseł dev.
  (cd / && runuser -u postgres -- psql -q -X -d postgres) <<SQL
\set ON_ERROR_STOP on
\set app_pw '$app_pw'
\set owner_pw '$owner_pw'
SELECT 'CREATE ROLE nova_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_owner') \gexec
SELECT 'CREATE ROLE nova_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') \gexec
ALTER ROLE nova_owner PASSWORD :'owner_pw';
ALTER ROLE nova_app PASSWORD :'app_pw';
SELECT 'CREATE DATABASE novaai OWNER nova_owner'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'novaai') \gexec
GRANT CONNECT ON DATABASE novaai TO nova_app;
SQL
  echo "Baza novaai gotowa."

  step "Usługi systemd i Caddy"
  install -m 755 "$APP/infra/deploy/backup.sh" /usr/local/sbin/novaai-backup
  install -m 644 "$APP/infra/deploy/novaai.service" /etc/systemd/system/novaai.service
  install -m 644 "$APP/infra/deploy/novaai-backup.service" /etc/systemd/system/novaai-backup.service
  install -m 644 "$APP/infra/deploy/novaai-backup.timer" /etc/systemd/system/novaai-backup.timer
  systemctl daemon-reload
  systemctl enable --quiet novaai.service novaai-backup.timer
  systemctl start novaai-backup.timer
  validate_caddy
  install -m 644 "$APP/infra/deploy/Caddyfile" /etc/caddy/Caddyfile
  systemctl enable --quiet caddy
  systemctl reload-or-restart caddy

  step "Instalacja zależności, build, migracje, start"
  bash "$APP/infra/deploy/update.sh" --no-pull

  cat <<EOF

Gotowe: https://$DOMAIN (certyfikat HTTPS Caddy pobiera przy pierwszym wejściu — do minuty).

Dalej (docs/DEPLOY.md → „Wdrożenie”):
  1. Klucze usług:   sudo nano $APP/.env     potem   sudo systemctl restart novaai
  2. Twój dom:       sudo bash $APP/infra/deploy/admin.sh create-household "Nasz dom" "twoj@email:Imię"
  3. Twój klucz:     sudo bash $APP/infra/deploy/admin.sh enroll twoj@email
                     → otwórz wypisany link (15 min) i utwórz klucz dostępu.
EOF
}

main "$@"
