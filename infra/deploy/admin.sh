#!/usr/bin/env bash
# Polecenia administracyjne NovaAI na serwerze (jako użytkownik aplikacji), np.:
#   sudo bash /opt/novaai/app/infra/deploy/admin.sh create-household "Nasz dom" "osoba@example.com:Imię"
#   sudo bash /opt/novaai/app/infra/deploy/admin.sh enroll osoba@example.com
#   sudo bash /opt/novaai/app/infra/deploy/admin.sh disable-user osoba@example.com
set -euo pipefail
cd /opt/novaai/app
exec sudo -u novaai -H pnpm --silent --filter @nova/api admin:prod "$@"
