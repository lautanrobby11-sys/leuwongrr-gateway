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

INTEGRITY=$(sqlite3 "$WORK/gateway.db" 'PRAGMA integrity_check;')
if [[ $INTEGRITY != ok ]]; then
  printf 'integrity check failed: %s\n' "$INTEGRITY" >&2
  exit 1
fi

# A healthy database prints nothing here, so the assertion is on empty output
# rather than on a matching line.
FOREIGN_KEYS=$(sqlite3 "$WORK/gateway.db" 'PRAGMA foreign_key_check;')
if [[ -n $FOREIGN_KEYS ]]; then
  printf 'foreign key violations detected:\n%s\n' "$FOREIGN_KEYS" >&2
  exit 1
fi

# Proves the restored file is a gateway database and not an empty shell.
TABLES=$(sqlite3 "$WORK/gateway.db" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('tenants','api_keys','model_policies');")
if [[ $TABLES != 3 ]]; then
  printf 'restored schema is incomplete: expected 3 core tables, found %s\n' "$TABLES" >&2
  exit 1
fi

echo 'restore drill passed'
