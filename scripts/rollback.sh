#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT=/opt/leuwongrr-gateway
SHA=${1:-}
[[ $EUID -eq 0 ]] || { echo 'rollback must run as root' >&2; exit 1; }
[[ $SHA =~ ^[0-9a-f]{40}$ && -d $ROOT/releases/$SHA ]] || { echo 'existing release SHA required' >&2; exit 1; }
CURRENT=$(readlink -f "$ROOT/current")
TARGET="$ROOT/releases/$SHA"
[[ $CURRENT != "$TARGET" ]] || { echo 'target already active'; exit 0; }
ln -s "$TARGET" "$ROOT/.rollback-$SHA"; mv -Tf "$ROOT/.rollback-$SHA" "$ROOT/current"
if ! systemctl restart leuwongrr-gateway || ! timeout 30 bash -c 'until curl -fsS http://127.0.0.1:2080/health/live >/dev/null; do sleep 1; done'; then
  ln -s "$CURRENT" "$ROOT/.rollback-revert"; mv -Tf "$ROOT/.rollback-revert" "$ROOT/current"; systemctl restart leuwongrr-gateway
  echo 'rollback target unhealthy; original release restored' >&2; exit 1
fi
printf '%s\n' "$SHA" > "$ROOT/runtime/active-sha"
echo "rolled back from $CURRENT to $TARGET"
