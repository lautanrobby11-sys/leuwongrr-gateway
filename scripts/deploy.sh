#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT=/opt/leuwongrr-gateway
SERVICE=leuwongrr-gateway
SHA=${1:-}
ARTIFACT=${2:-}
RELEASE=
ACTIVATED=0

cleanup_failed_release() {
  local rc=$?
  if [[ $rc -ne 0 && $ACTIVATED -eq 0 && -n ${RELEASE:-} && -d $RELEASE ]]; then
    if [[ $(readlink -f "$ROOT/current" 2>/dev/null || true) != "$RELEASE" ]]; then
      rm -rf -- "$RELEASE"
    fi
  fi
  exit "$rc"
}
trap cleanup_failed_release EXIT

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

[[ $EUID -eq 0 ]] || fail 'deploy must run as root'
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || fail 'full git SHA required'
[[ -n $ARTIFACT && -f $ARTIFACT && -f ${ARTIFACT}.sha256 ]] || fail 'artifact and .sha256 required'

(
  cd "$(dirname "$ARTIFACT")"
  sha256sum -c "$(basename "$ARTIFACT").sha256"
)

id "$SERVICE" >/dev/null 2>&1 || fail 'service user is missing'
install -d -o root -g "$SERVICE" -m 0750 "$ROOT" "$ROOT/releases" "$ROOT/config"
install -d -o "$SERVICE" -g "$SERVICE" -m 0750 \
  "$ROOT/data" "$ROOT/data/attachments" "$ROOT/data/backups" "$ROOT/logs" "$ROOT/runtime"

ENV_FILE="$ROOT/config/gateway.env"
[[ -f $ENV_FILE ]] || fail 'missing config/gateway.env'
[[ $(stat -c %a "$ENV_FILE") == 600 ]] || fail 'gateway.env must be mode 600'
[[ $(stat -c %U:%G "$ENV_FILE") == root:root ]] || fail 'gateway.env must be owned by root:root'

RELEASE="$ROOT/releases/$SHA"
[[ ! -e $RELEASE ]] || fail 'immutable release already exists'
mkdir -m 0750 "$RELEASE"
tar --extract --file "$ARTIFACT" --directory "$RELEASE" --no-same-owner --no-same-permissions
(
  cd "$RELEASE"
  sha256sum -c manifest.sha256 >/dev/null
)

[[ -f $RELEASE/package-lock.json ]] || fail 'package-lock.json is required for deterministic production deploy'
(
  cd "$RELEASE"
  npm ci --omit=dev --ignore-scripts=false --no-audit --no-fund
)

chown -R root:"$SERVICE" "$RELEASE"
chmod -R u=rwX,g=rX,o= "$RELEASE"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
[[ ${GATEWAY_HOST:-} == 127.0.0.1 && ${GATEWAY_PORT:-} == 2080 ]] || fail 'production origin must be 127.0.0.1:2080'

runuser --preserve-environment -u "$SERVICE" -- node "$RELEASE/dist/preflight.js"

PREVIOUS=$(readlink -f "$ROOT/current" 2>/dev/null || true)
CANDIDATE_LINK="$ROOT/.current-$SHA"
ln -s "$RELEASE" "$CANDIDATE_LINK"
mv -Tf "$CANDIDATE_LINK" "$ROOT/current"

if ! systemctl restart "$SERVICE" || ! wait_for_health; then
  if [[ -n $PREVIOUS && -d $PREVIOUS ]]; then
    ln -s "$PREVIOUS" "$ROOT/.rollback"
    mv -Tf "$ROOT/.rollback" "$ROOT/current"
    systemctl restart "$SERVICE" || true
    wait_for_health || echo 'warning: previous release did not recover readiness' >&2
  else
    rm -f "$ROOT/current"
    systemctl stop "$SERVICE" || true
  fi
  fail 'deployment failed; previous release restored when available'
fi

printf '%s\n' "$SHA" > "$ROOT/runtime/active-sha"
chown "$SERVICE:$SERVICE" "$ROOT/runtime/active-sha"
chmod 0640 "$ROOT/runtime/active-sha"
ACTIVATED=1
echo "deployed $SHA; previous=${PREVIOUS:-none}"
