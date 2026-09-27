#!/usr/bin/env bash
# Kopia bazy NovaAI: pg_dump w formacie custom do /var/backups/novaai, trzymane 14 dni.
# Instalowany jako /usr/local/sbin/novaai-backup (update.sh). Uruchamia novaai-backup.timer (codziennie)
# albo ręcznie: sudo novaai-backup
# Odtworzenie: docs/DEPLOY.md → „Kopie zapasowe”. Kopie zostają na tym serwerze — ściągaj je co jakiś czas
# na własny komputer (scp), bo awaria dysku VPS zabierze je razem z bazą.
set -euo pipefail

DB=novaai
DIR=/var/backups/novaai
KEEP_DAYS=14

install -d -m 700 -o root -g root "$DIR"
file="$DIR/novaai-$(date +%Y%m%d-%H%M%S).dump"
trap 'rm -f "$file.part"' ERR
(cd / && runuser -u postgres -- pg_dump --format=custom "$DB") >"$file.part"
chmod 600 "$file.part"
mv "$file.part" "$file"
find "$DIR" -name 'novaai-*.dump' -mtime +"$KEEP_DAYS" -delete
echo "Kopia: $file ($(du -h "$file" | cut -f1))"
