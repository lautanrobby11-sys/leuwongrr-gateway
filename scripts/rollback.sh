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

# Mirrors deploy.sh. readlink -f returns the link path itself when the target
# is missing, which makes a broken link look like a usable release and can end
# with current pointing at itself.
resolve_current() {
  [[ -L $ROOT/current ]] || return 0
  local resolved
  resolved=$(readlink -e "$ROOT/current") || return 0
  [[ $resolved != "$ROOT/current" ]] || return 0
  printf '%s\n' "$resolved"
}

# The unit ships with each release, so the active release and the running unit
# stay in step even when moving backwards.
sync_unit() {
  local src="$1/infra/systemd/$SERVICE.service"
  local dst="/etc/systemd/system/$SERVICE.service"
  [[ -f $src ]] || return 0
  if ! cmp -s "$src" "$dst"; then
    install -m 0644 -o root -g root "$src" "$dst"
    systemctl daemon-reload
    echo "systemd unit synced from $1"
  fi
}

check_health() {
  curl -fsS --max-time 2 http://127.0.0.1:2080/health/live >/dev/null &&
    printf 'x-internal-ready-token: %s\n' "$INTERNAL_READY_TOKEN" |
      curl -fsS --max-time 2 -H @- http://127.0.0.1:2080/health/ready >/dev/null
}

wait_for_health() {
  local deadline=$((SECONDS + 30))
  until check_health 2>/dev/null; do
    (( SECONDS >= deadline )) && return 1
    sleep 1
  done
}

run_preflight() {
  runuser --preserve-environment -u "$SERVICE" -- \
    bash -c 'cd "$1" && exec node dist/preflight.js' _ "$1"
}

[[ $EUID -eq 0 ]] || fail 'rollback must run as root'
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || fail 'full release SHA required'
TARGET="$ROOT/releases/$SHA"
[[ -d $TARGET ]] || fail 'rollback target does not exist'
CURRENT=$(resolve_current)
[[ -n $CURRENT && -d $CURRENT ]] || fail 'current release is missing'
[[ $CURRENT != "$TARGET" ]] || { echo 'target already active'; exit 0; }

ENV_FILE="$ROOT/config/gateway.env"
[[ -f $ENV_FILE && $(stat -c %a "$ENV_FILE") == 600 ]] || fail 'valid gateway.env is required'
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

run_preflight "$TARGET"
ln -s "$TARGET" "$ROOT/.rollback-$SHA"
mv -Tf "$ROOT/.rollback-$SHA" "$ROOT/current"
sync_unit "$TARGET"
systemctl reset-failed "$SERVICE" 2>/dev/null || true

if ! systemctl restart "$SERVICE" || ! wait_for_health; then
  ln -s "$CURRENT" "$ROOT/.rollback-revert"
  mv -Tf "$ROOT/.rollback-revert" "$ROOT/current"
  sync_unit "$CURRENT"
  systemctl reset-failed "$SERVICE" 2>/dev/null || true
  systemctl restart "$SERVICE" || true
  wait_for_health || echo 'warning: original release did not recover readiness' >&2
  fail 'rollback target unhealthy; original release restored'
fi

printf '%s\n' "$SHA" > "$ROOT/runtime/active-sha"
chown "$SERVICE:$SERVICE" "$ROOT/runtime/active-sha"
chmod 0640 "$ROOT/runtime/active-sha"
echo "rolled back from $CURRENT to $TARGET"
