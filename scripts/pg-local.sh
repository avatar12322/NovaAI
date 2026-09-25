#!/usr/bin/env bash
# Lokalny klaster PostgreSQL dla dev/test bez Dockera (Linux/macOS).
# Dane: ./.data/pg (ignorowane przez Git). Port: ${NOVA_PG_PORT:-54329}.
# Na Windows użyj infra/compose.yaml (Docker Desktop) albo natywnej instalacji Postgres
# i uruchom infra/db/init.sql jako superużytkownik.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT/.data/pg"
PORT="${NOVA_PG_PORT:-54329}"
SOCK_DIR="$ROOT/.data/pg-sock"
LOG_FILE="$ROOT/.data/pg.log"

find_bin() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return; fi
  for d in /usr/lib/postgresql/*/bin /usr/local/opt/postgresql*/bin /opt/homebrew/opt/postgresql*/bin; do
    if [ -x "$d/$name" ]; then echo "$d/$name"; return; fi
  done
  echo "Nie znaleziono $name — zainstaluj PostgreSQL 16+ albo użyj infra/compose.yaml" >&2
  exit 1
}

INITDB="$(find_bin initdb)"
PG_CTL="$(find_bin pg_ctl)"
PSQL="$(find_bin psql)"

# Postgres nie uruchamia się jako root; w kontenerach dev używamy konta "postgres".
as_pg() {
  if [ "$(id -u)" = "0" ]; then
    runuser -u postgres -- "$@"
  else
    "$@"
  fi
}

ensure_dirs() {
  mkdir -p "$DATA_DIR" "$SOCK_DIR"
  if [ "$(id -u)" = "0" ]; then
    chown -R postgres:postgres "$ROOT/.data"
    chmod 700 "$DATA_DIR"
  fi
}

cmd_init() {
  ensure_dirs
  if [ ! -f "$DATA_DIR/PG_VERSION" ]; then
    as_pg "$INITDB" -D "$DATA_DIR" -U postgres --auth=trust --encoding=UTF8 --locale=C.UTF-8 >/dev/null
    {
      echo "listen_addresses = '127.0.0.1'"
      echo "port = $PORT"
      echo "unix_socket_directories = '$SOCK_DIR'"
      echo "fsync = on"
      echo "max_connections = 100"
    } | as_pg tee -a "$DATA_DIR/postgresql.conf" >/dev/null
    # Lokalny klaster dev: tylko loopback, hasła md5/scram dla ról aplikacji.
    cat <<HBA | as_pg tee "$DATA_DIR/pg_hba.conf" >/dev/null
local   all   postgres                 trust
local   all   all                      scram-sha-256
host    all   postgres  127.0.0.1/32   trust
host    all   all       127.0.0.1/32   scram-sha-256
HBA
    echo "Zainicjowano klaster w $DATA_DIR"
  fi
}

cmd_start() {
  cmd_init
  if as_pg "$PG_CTL" -D "$DATA_DIR" status >/dev/null 2>&1; then
    echo "Postgres już działa (port $PORT)"
  else
    touch "$LOG_FILE"; [ "$(id -u)" = "0" ] && chown postgres:postgres "$LOG_FILE"
    as_pg "$PG_CTL" -D "$DATA_DIR" -l "$LOG_FILE" -w start >/dev/null
    echo "Postgres uruchomiony (port $PORT)"
  fi
  # Idempotentne utworzenie ról i baz (dev/test).
  "$PSQL" -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f "$ROOT/infra/db/init.sql"
}

cmd_stop() {
  if [ -f "$DATA_DIR/PG_VERSION" ]; then
    as_pg "$PG_CTL" -D "$DATA_DIR" -m fast stop >/dev/null 2>&1 || true
  fi
  echo "Postgres zatrzymany"
}

cmd_status() {
  if [ -f "$DATA_DIR/PG_VERSION" ] && as_pg "$PG_CTL" -D "$DATA_DIR" status >/dev/null 2>&1; then
    echo "running (port $PORT)"
  else
    echo "stopped"
    exit 1
  fi
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  psql) shift; exec "$PSQL" -h 127.0.0.1 -p "$PORT" -U postgres "$@" ;;
  *) echo "Użycie: $0 {start|stop|status|psql}"; exit 2 ;;
esac
