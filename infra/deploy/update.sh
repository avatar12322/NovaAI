#!/usr/bin/env bash
# Aktualizacja NovaAI na serwerze: kod z gałęzi, zależności, build, migracje, restart, sprawdzenie zdrowia.
#   sudo bash /opt/novaai/app/infra/deploy/update.sh            (--no-pull: bez pobierania kodu)
# Pliki usług (systemd, Caddy, skrypt kopii) z repozytorium są wgrywane przy każdej aktualizacji.
set -euo pipefail

APP_USER=novaai
APP=/opt/novaai/app
HEALTH=http://127.0.0.1:4000/api/health

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
validate_caddy() {
  local out
  if ! out=$(caddy validate --adapter caddyfile --config "$APP/infra/deploy/Caddyfile" 2>&1); then
    echo "$out" >&2
    return 1
  fi
}
as_app() { (cd "$APP" && sudo -u "$APP_USER" -H "$@"); }

# Całość w funkcji: bash wczytuje skrypt przed wykonaniem, więc git pull może bezpiecznie podmienić ten plik.
main() {
  if [[ $EUID -ne 0 ]]; then
    echo "Uruchom przez sudo: sudo bash $0" >&2
    exit 1
  fi
  local before after branch
  before=$(as_app git rev-parse HEAD)
  if [[ ${1:-} != --no-pull ]]; then
    branch=$(as_app git rev-parse --abbrev-ref HEAD)
    step "Kod ($branch)"
    as_app git fetch --quiet origin "$branch"
    as_app git merge --ff-only --quiet FETCH_HEAD
  fi
  after=$(as_app git rev-parse HEAD)
  as_app git log --oneline -1

  step "Zależności i build"
  as_app pnpm install --frozen-lockfile --config.confirmModulesPurge=false
  as_app pnpm build:prod

  step "Pliki usług (systemd, Caddy, kopia bazy)"
  install -m 755 "$APP/infra/deploy/backup.sh" /usr/local/sbin/novaai-backup
  local unit changed=0
  for unit in novaai.service novaai-backup.service novaai-backup.timer; do
    if ! cmp -s "$APP/infra/deploy/$unit" "/etc/systemd/system/$unit"; then
      install -m 644 "$APP/infra/deploy/$unit" "/etc/systemd/system/$unit"
      changed=1
    fi
  done
  if [[ $changed == 1 ]]; then systemctl daemon-reload; fi
  if ! cmp -s "$APP/infra/deploy/Caddyfile" /etc/caddy/Caddyfile; then
    validate_caddy
    install -m 644 "$APP/infra/deploy/Caddyfile" /etc/caddy/Caddyfile
    systemctl reload caddy
  fi

  step "Migracje bazy"
  if [[ $before != "$after" ]]; then
    echo "Kopia bazy przed migracją:"
    /usr/local/sbin/novaai-backup
  fi
  as_app pnpm --silent --filter @nova/api admin:prod migrate

  step "Restart"
  systemctl restart novaai

  step "Sprawdzenie"
  local body=''
  for _ in $(seq 1 30); do
    if body=$(curl -fsS "$HEALTH" 2>/dev/null); then break; fi
    sleep 1
  done
  if [[ -z $body ]]; then
    echo "NovaAI nie odpowiada na $HEALTH. Logi: journalctl -u novaai -n 50 --no-pager" >&2
    exit 1
  fi
  # shellcheck disable=SC2016  # kod JS, nie powłoka
  echo "$body" | node -e '
    const h = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const m = h.migrations ?? { applied: "?", pending: "?" };
    console.log(`NovaAI ${h.version} (${h.env}) — baza: ${h.db}, migracje: ${m.applied} zastosowanych, ` +
      `${m.pending} oczekujących, kolejka: ${h.queue}, logowanie testowe: ${h.devLogin ? "WŁĄCZONE" : "wyłączone"}`);
    if (h.db !== "ok" || h.env !== "production" || h.devLogin || m.pending !== 0) process.exit(1);'
}

main "$@"
