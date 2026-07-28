#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
BACKUP=${1:?encrypted backup required}
IDENTITY=${2:?age identity file required}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
sha256sum -c "${BACKUP}.sha256"
age -d -i "$IDENTITY" "$BACKUP" | tar -xzf - -C "$WORK"
( cd "$WORK" && sha256sum -c manifest.sha256 )
sqlite3 "$WORK/gateway.db" 'PRAGMA integrity_check;' | grep -qx ok
sqlite3 "$WORK/gateway.db" 'PRAGMA foreign_key_check;' | grep -qx ''
echo 'restore drill passed'
