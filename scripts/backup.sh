#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT=/opt/leuwongrr-gateway

require_commands() {
  local missing=()
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
  done
  if (( ${#missing[@]} > 0 )); then
    printf 'missing required command(s): %s\n' "${missing[*]}" >&2
    printf 'install with: apt-get install -y %s\n' "${missing[*]}" >&2
    exit 1
  fi
}

# Checked before any work so a missing tool cannot fail mid-run after a temp
# directory exists. The gateway embeds SQLite through better-sqlite3 and never
# needs the sqlite3 CLI, so the service can be healthy on a host that cannot
# produce a backup at all.
require_commands sqlite3 age rsync tar sha256sum
: "${AGE_RECIPIENT:?AGE_RECIPIENT is required}"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK=$(mktemp -d "$ROOT/runtime/backup.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
sqlite3 "$ROOT/data/gateway.db" ".timeout 5000" ".backup '$WORK/gateway.db'"
mkdir "$WORK/attachments"
rsync -a --delete "$ROOT/data/attachments/" "$WORK/attachments/"
( cd "$WORK" && find gateway.db attachments -type f -print0 | sort -z | xargs -0 sha256sum > manifest.sha256 )
tar -C "$WORK" -czf - gateway.db attachments manifest.sha256 | age -r "$AGE_RECIPIENT" -o "$ROOT/data/backups/$STAMP.tar.gz.age"
sha256sum "$ROOT/data/backups/$STAMP.tar.gz.age" > "$ROOT/data/backups/$STAMP.tar.gz.age.sha256"
chmod 600 "$ROOT/data/backups/$STAMP.tar.gz.age" "$ROOT/data/backups/$STAMP.tar.gz.age.sha256"

# Retention runs only after the new archive exists and its checksum is written,
# so a failed run can never delete the last good copy. Pruning is by count, not
# age: a host that stops taking snapshots must keep the old ones rather than
# quietly expire into having none.
KEEP=${BACKUP_KEEP:-14}
if [[ $KEEP =~ ^[0-9]+$ ]] && (( KEEP > 0 )); then
  while IFS= read -r stale; do
    [[ -n $stale ]] || continue
    rm -f "$stale" "$stale.sha256"
  done < <(ls -1t "$ROOT"/data/backups/*.tar.gz.age 2>/dev/null | tail -n +$((KEEP + 1)) || true)
fi

echo "$STAMP"
