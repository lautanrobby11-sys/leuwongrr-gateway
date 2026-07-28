#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT=/opt/leuwongrr-gateway
SERVICE=leuwongrr-gateway
SHA=${1:-}

fail() {
  echo "$1" >&2
  exit 1
}

check_health() {
  curl -fsS --max-time 2 http://127.0.0.1:2080/health/live >/dev/null &&
    printf 'x-internal-ready-token: %s\n' "$INTERNAL_READY_TOKEN" |
      curl -fsS --max-time 2 -H @- http://127.0.0.1:2080/health/ready >/dev/null
}

wait_for_health() {
  local deadline=$((SECONDS + 30))
  until check_health; do
    (( SECONDS >= deadline )) && return 1
    sleep 1
  done
}

[[ $EUID -eq 0 ]] || fail 'rollback must run as root'
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || fail 'full release SHA required'
TARGET="$ROOT/releases/$SHA"
[[ -d $TARGET ]] || fail 'rollback target does not exist'
CURRENT=$(readlink -f "$ROOT/current" 2>/dev/null || true)
[[ -n $CURRENT && -d $CURRENT ]] || fail 'current release is missing'
[[ $CURRENT != "$TARGET" ]] || { echo 'target already active'; exit 0; }

ENV_FILE="$ROOT/config/gateway.env"
[[ -f $ENV_FILE && $(stat -c %a "$ENV_FILE") == 600 ]] || fail 'valid gateway.env is required'
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

runuser --preserve-environment -u "$SERVICE" -- node "$TARGET/dist/preflight.js"
ln -s "$TARGET" "$ROOT/.rollback-$SHA"
mv -Tf "$ROOT/.rollback-$SHA" "$ROOT/current"

if ! systemctl restart "$SERVICE" || ! wait_for_health; then
  ln -s "$CURRENT" "$ROOT/.rollback-revert"
  mv -Tf "$ROOT/.rollback-revert" "$ROOT/current"
  systemctl restart "$SERVICE" || true
  wait_for_health || echo 'warning: original release did not recover readiness' >&2
  fail 'rollback target unhealthy; original release restored'
fi

printf '%s\n' "$SHA" > "$ROOT/runtime/active-sha"
chown "$SERVICE:$SERVICE" "$ROOT/runtime/active-sha"
chmod 0640 "$ROOT/runtime/active-sha"
echo "rolled back from $CURRENT to $TARGET"
