#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT=/opt/leuwongrr-gateway
SERVICE=leuwongrr-gateway
SHA=${1:-}
readonly HEALTH_REQUEST_TIMEOUT_SECONDS=5
readonly HEALTH_STARTUP_DEADLINE_SECONDS=90
readonly HEALTH_RETRY_INTERVAL_SECONDS=1

fail() {
  echo "$1" >&2
  exit 1
}

resolve_current() {
  [[ -L $ROOT/current ]] || return 0
  local resolved
  resolved=$(readlink -e "$ROOT/current") || return 0
  [[ $resolved != "$ROOT/current" ]] || return 0
  printf '%s\n' "$resolved"
}

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
  curl -fsS --max-time "$HEALTH_REQUEST_TIMEOUT_SECONDS" http://127.0.0.1:2080/health/live >/dev/null &&
    printf 'x-internal-ready-token: %s\n' "$INTERNAL_READY_TOKEN" |
      curl -fsS --max-time "$HEALTH_REQUEST_TIMEOUT_SECONDS" -H @- http://127.0.0.1:2080/health/ready >/dev/null
}

wait_for_health() {
  local deadline=$((SECONDS + HEALTH_STARTUP_DEADLINE_SECONDS))
  until check_health 2>/dev/null; do
    (( SECONDS >= deadline )) && return 1
    sleep "$HEALTH_RETRY_INTERVAL_SECONDS"
  done
}

run_preflight() {
  runuser --preserve-environment -u "$SERVICE" -- \
    bash -c 'cd "$1" && exec node dist/preflight.js' _ "$1"
}

verify_release_manifest() {
  local target=$1
  [[ -f $target/manifest.sha256 ]] || {
    echo 'rollback target manifest.sha256 is missing' >&2
    return 1
  }
  (
    cd "$target"
    sha256sum -c manifest.sha256 --quiet
  ) || {
    echo 'rollback target manifest verification failed' >&2
    return 1
  }
}

# A rollback is release evidence (ADR-012): it must be durable, not just echoed.
# Runs as root and must never follow a symlink a compromised service could
# plant, so it writes into a root-only evidence directory (0700) rather than
# the service-owned logs/. The evidence directory must be owned by the running
# user (root in production) and must not itself be a symlink, and the log file
# must be a regular file, not a symlink. The whole block is non-fatal: a
# rollback that already succeeded must not be aborted by an evidence problem.
record_rollback_evidence() {
  local evidence_dir="$ROOT/evidence"
  if [[ -L $evidence_dir ]]; then
    echo 'warning: refusing to use symlink evidence directory' >&2
    return 0
  fi
  if [[ -e $evidence_dir && ! -d $evidence_dir ]]; then
    echo 'warning: evidence path is not a directory' >&2
    return 0
  fi
  if ! mkdir -p "$evidence_dir" 2>/dev/null; then
    echo 'warning: could not create evidence directory' >&2
    return 0
  fi
  if [[ $(stat -c %u "$evidence_dir" 2>/dev/null) != "$EUID" ]]; then
    echo 'warning: evidence directory must be owned by the rollback user' >&2
    return 0
  fi
  if ! chmod 0700 "$evidence_dir" 2>/dev/null; then
    echo 'warning: could not secure evidence directory mode' >&2
    return 0
  fi
  if [[ -L "$evidence_dir/rollback.log" ]]; then
    echo 'warning: refusing to follow symlink rollback.log' >&2
    return 0
  fi
  if [[ -e "$evidence_dir/rollback.log" && ! -f "$evidence_dir/rollback.log" ]]; then
    echo 'warning: refusing to write non-regular rollback.log' >&2
    return 0
  fi
  if {
    echo "$(date -u -Is) rolled back from $(basename "$CURRENT") to $SHA"
    printf '%s\n' '---'
  } >> "$evidence_dir/rollback.log" 2>/dev/null; then
    chmod 0640 "$evidence_dir/rollback.log" 2>/dev/null || true
  else
    echo 'warning: could not append rollback.log' >&2
  fi
}

if [[ ${BASH_SOURCE[0]} != "$0" ]]; then
  return 0
fi

[[ $EUID -eq 0 ]] || fail 'rollback must run as root'
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || fail 'full release SHA required'
TARGET="$ROOT/releases/$SHA"
[[ -d $TARGET ]] || fail 'rollback target does not exist'
CURRENT=$(resolve_current)
[[ -n $CURRENT && -d $CURRENT ]] || fail 'current release is missing'
[[ $CURRENT != "$TARGET" ]] || { echo 'target already active'; exit 0; }

verify_release_manifest "$TARGET" || fail 'rollback target failed integrity verification'

ENV_FILE="$ROOT/config/gateway.env"
[[ -f $ENV_FILE && $(stat -c %a "$ENV_FILE") == 600 ]] || fail 'valid gateway.env is required'
[[ $(stat -c %U:%G "$ENV_FILE") == root:root ]] || fail 'gateway.env must be owned by root:root'
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
record_rollback_evidence
  echo "rolled back from $(basename "$CURRENT") to $(basename "$TARGET")"
