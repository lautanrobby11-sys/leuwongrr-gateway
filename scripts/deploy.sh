#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT=/opt/leuwongrr-gateway
SERVICE=leuwongrr-gateway
SHA=${1:-}
ARTIFACT=${2:-}
RELEASE=
ACTIVATED=0
readonly HEALTH_REQUEST_TIMEOUT_SECONDS=5
readonly HEALTH_STARTUP_DEADLINE_SECONDS=90
readonly HEALTH_RETRY_INTERVAL_SECONDS=1

# readlink -f canonicalises a path even when the final component does not
# exist, so it happily returns "$ROOT/current" when nothing is deployed yet.
# Feeding that value back into `ln -s` produces a symlink pointing at itself
# and every later start fails with ELOOP. -e resolves only when the whole
# chain exists, and the explicit -L test keeps a dangling link from counting
# as a usable previous release.
resolve_current() {
  [[ -L $ROOT/current ]] || return 0
  local resolved
  resolved=$(readlink -e "$ROOT/current") || return 0
  [[ $resolved != "$ROOT/current" ]] || return 0
  printf '%s\n' "$resolved"
}

cleanup_failed_release() {
  local rc=$?
  if [[ $rc -ne 0 && $ACTIVATED -eq 0 && -n ${RELEASE:-} && -d $RELEASE ]]; then
    if [[ $(resolve_current) != "$RELEASE" ]]; then
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

# The unit file ships inside the artifact, so the running service definition
# is part of the release contract rather than something an operator has to
# remember to copy by hand. A release whose code and unit disagree can crash
# loop for reasons no amount of application debugging will explain.
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
  local status
  local rc

  if status=$(curl -sS -o /dev/null -w '%{http_code}' \
    --max-time "$HEALTH_REQUEST_TIMEOUT_SECONDS" \
    http://127.0.0.1:2080/health/live); then
    if [[ $status != 200 ]]; then
      echo "health probe: liveness returned HTTP $status" >&2
      return 1
    fi
  else
    rc=$?
    echo "health probe: liveness transport failure rc=$rc" >&2
    return 1
  fi

  if status=$(printf 'x-internal-ready-token: %s\n' "$INTERNAL_READY_TOKEN" |
    curl -sS -o /dev/null -w '%{http_code}' \
      --max-time "$HEALTH_REQUEST_TIMEOUT_SECONDS" -H @- \
      http://127.0.0.1:2080/health/ready); then
    if [[ $status != 200 ]]; then
      echo "health probe: readiness returned HTTP $status" >&2
      return 1
    fi
  else
    rc=$?
    echo "health probe: readiness transport failure rc=$rc" >&2
    return 1
  fi
}

wait_for_health() {
  local deadline=$((SECONDS + HEALTH_STARTUP_DEADLINE_SECONDS))
  local retries=0
  until check_health; do
    retries=$((retries + 1))
    if (( SECONDS >= deadline )); then
      echo "health gate exhausted after ${HEALTH_STARTUP_DEADLINE_SECONDS}s (${retries} failed probes)" >&2
      return 1
    fi
    sleep "$HEALTH_RETRY_INTERVAL_SECONDS"
  done
  echo "health gate passed after ${retries} failed probes"
}

# Preflight runs from inside the candidate release so any relative path it
# resolves matches what systemd will use once the symlink moves.
run_preflight() {
  runuser --preserve-environment -u "$SERVICE" -- \
    bash -c 'cd "$1" && exec node dist/preflight.js' _ "$1"
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

# A self-referential or dangling current link is unusable and would otherwise
# survive into the next deploy, so clear it before anything depends on it.
if [[ -L $ROOT/current && -z $(resolve_current) ]]; then
  echo 'removing unusable current symlink' >&2
  rm -f "$ROOT/current"
fi

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
[[ -f $RELEASE/infra/systemd/$SERVICE.service ]] || fail 'systemd unit missing from release'

# A release without the console would still pass health checks, so the dashboards
# are verified as part of the artifact contract rather than discovered by a user.
for page in admin member chat login; do
  [[ -f $RELEASE/dist/public/$page.html ]] || fail "console entry missing from release: $page.html"
done

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

run_preflight "$RELEASE"

PREVIOUS=$(resolve_current)
CANDIDATE_LINK="$ROOT/.current-$SHA"
ln -s "$RELEASE" "$CANDIDATE_LINK"
mv -Tf "$CANDIDATE_LINK" "$ROOT/current"

sync_unit "$RELEASE"
# A crash loop from an earlier attempt can exhaust StartLimitBurst, and then
# systemctl restart refuses to start the service at all. Clearing that state
# keeps a good release from being blocked by a bad one.
systemctl reset-failed "$SERVICE" 2>/dev/null || true

if ! systemctl restart "$SERVICE" || ! wait_for_health; then
  if [[ -n $PREVIOUS && -d $PREVIOUS ]]; then
    ln -s "$PREVIOUS" "$ROOT/.rollback"
    mv -Tf "$ROOT/.rollback" "$ROOT/current"
    sync_unit "$PREVIOUS"
    systemctl reset-failed "$SERVICE" 2>/dev/null || true
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
