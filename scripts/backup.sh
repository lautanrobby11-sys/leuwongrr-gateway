#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT=/opt/leuwongrr-gateway
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK=$(mktemp -d "$ROOT/runtime/backup.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
: "${AGE_RECIPIENT:?AGE_RECIPIENT is required}"
sqlite3 "$ROOT/data/gateway.db" ".timeout 5000" ".backup '$WORK/gateway.db'"
mkdir "$WORK/attachments"
rsync -a --delete "$ROOT/data/attachments/" "$WORK/attachments/"
( cd "$WORK" && find gateway.db attachments -type f -print0 | sort -z | xargs -0 sha256sum > manifest.sha256 )
tar -C "$WORK" -czf - gateway.db attachments manifest.sha256 | age -r "$AGE_RECIPIENT" -o "$ROOT/data/backups/$STAMP.tar.gz.age"
sha256sum "$ROOT/data/backups/$STAMP.tar.gz.age" > "$ROOT/data/backups/$STAMP.tar.gz.age.sha256"
chmod 600 "$ROOT/data/backups/$STAMP.tar.gz.age" "$ROOT/data/backups/$STAMP.tar.gz.age.sha256"
echo "$STAMP"
