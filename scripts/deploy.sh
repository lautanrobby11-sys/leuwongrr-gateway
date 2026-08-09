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
readonly NPM_INSTALL_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
readonly RELEASE_SIGNERS=/opt/leuwongrr-gateway/config/release-signers
readonly SIGNER_PRINCIPAL=release-signer
readonly SIGNATURE_NAMESPACE=file

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

validate_production_config() {
  local env_file=$1
  [[ -f $env_file ]] || fail 'missing config/gateway.env'
  [[ $(stat -c %a "$env_file") == 600 ]] || fail 'gateway.env must be mode 600'
  [[ $(stat -c %U:%G "$env_file") == root:root ]] || fail 'gateway.env must be owned by root:root'
  grep -q '^GATEWAY_HOST=127.0.0.1$' "$env_file" || fail 'production origin must be 127.0.0.1:2080'
  grep -q '^GATEWAY_PORT=2080$' "$env_file" || fail 'production origin must be 127.0.0.1:2080'
  grep -q '^OMNIROUTE_URL=http://127.0.0.1:20128$' "$env_file" || fail 'production upstream must be local tunnel'
  local key
  for key in OMNIROUTE_API_KEY API_KEY_PEPPER INTERNAL_READY_TOKEN; do
    grep -Eq "^${key}=.+$" "$env_file" || fail "production config missing $key"
  done
  if grep -Eq "(^|=)[\"']?REPLACE_ME[\"']?(\$|[[:space:]])" "$env_file"; then
    fail 'production config contains placeholder values'
  fi
}

# A16: the checksum travels with the artifact, so it proves integrity but not
# authenticity. The trust anchor is the host key list: a forged artifact fails
# here because the attacker lacks the operator's private key. The signature
# binds the .sha256 file, which in turn binds the tarball by content (A14).
# OpenSSH 9.6/10.x -Y verify reads the message from stdin and ignores a
# positional file argument, so the checksum is fed via redirection. The signers
# path is a parameter defaulting to the host anchor so tests can source this
# file and point it at a disposable key list.
verify_artifact_signature() {
  local artifact=$1
  local signers=${2:-$RELEASE_SIGNERS}
  local principal=${SIGNER_PRINCIPAL:-release-signer}
  local ns=${SIGNATURE_NAMESPACE:-file}
  [[ -f ${artifact}.sha256.sig ]] || fail 'artifact signature (.sha256.sig) missing; sign locally with scripts/sign-release.sh'
  [[ -f $signers ]] || fail "release signers file missing: $signers (seed from the artifact's keys/ on bootstrap)"
  command -v ssh-keygen >/dev/null 2>&1 || fail 'ssh-keygen required for artifact signature verification'
  if ! ssh-keygen -Y verify -f "$signers" -I "$principal" -n "$ns" \
    -s "${artifact}.sha256.sig" < "${artifact}.sha256" >/dev/null 2>&1; then
    fail 'artifact signature verification failed'
  fi
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
  local status
  local rc
  if status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$HEALTH_REQUEST_TIMEOUT_SECONDS" http://127.0.0.1:2080/health/live); then
    [[ $status == 200 ]] || { echo "health probe: liveness returned HTTP $status" >&2; return 1; }
  else
    rc=$?
    echo "health probe: liveness transport failure rc=$rc" >&2
    return 1
  fi
  if status=$(printf 'x-internal-ready-token: %s\n' "$INTERNAL_READY_TOKEN" |
    curl -sS -o /dev/null -w '%{http_code}' --max-time "$HEALTH_REQUEST_TIMEOUT_SECONDS" -H @- http://127.0.0.1:2080/health/ready); then
    [[ $status == 200 ]] || { echo "health probe: readiness returned HTTP $status" >&2; return 1; }
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

run_preflight() {
  runuser --preserve-environment -u "$SERVICE" -- bash -c 'cd "$1" && exec node dist/preflight.js' _ "$1"
}

# Install scripts are required for better-sqlite3, but they must neither run as
# root nor inherit deploy credentials or root-owned npm state. The user and
# global npm configs are pinned to two DISTINCT empty files under the isolated
# home: npm >= 9 aborts when both resolve to the same path ("double-loading
# config"). Parameters after service are fixed production dependencies at the
# call site; tests substitute disposable binaries to exercise this exact
# function without root privileges.
install_production_dependencies() {
  local release=$1
  local service=$2
  local install_path=$3
  local runuser_bin=$4
  local chown_bin=$5
  local npm_home="$release/.npm-home"
  local npm_cache="$release/.npm-cache"
  local rc=0

  "$chown_bin" -R root:"$service" "$release"
  chmod -R u=rwX,g=rwX,o= "$release"

  "$runuser_bin" -u "$service" -- /usr/bin/env -i \
    PATH="$install_path" \
    HOME="$npm_home" \
    npm_config_cache="$npm_cache" \
    npm_config_userconfig="$npm_home/npmrc-user" \
    npm_config_globalconfig="$npm_home/npmrc-global" \
    npm_config_update_notifier=false \
    /usr/bin/bash -c \
      'mkdir -p "$2" "$3"; : > "$2/npmrc-user"; : > "$2/npmrc-global"; cd "$1"; exec npm ci --omit=dev --ignore-scripts=false --no-audit --no-fund' \
      _ "$release" "$npm_home" "$npm_cache" || rc=$?

  rm -rf -- "$npm_home" "$npm_cache"
  "$chown_bin" -R root:"$service" "$release"
  chmod -R u=rwX,g=rX,o= "$release"
  return "$rc"
}

# Tests source the real functions and invoke install_production_dependencies
# with disposable command stubs. Executing this file can never take this path.
if [[ ${BASH_SOURCE[0]} != "$0" ]]; then
  return 0
fi

[[ $EUID -eq 0 ]] || fail 'deploy must run as root'
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || fail 'full git SHA required'
[[ -n $ARTIFACT && -f $ARTIFACT && -f ${ARTIFACT}.sha256 ]] || fail 'artifact and .sha256 required'

(
  cd "$(dirname "$ARTIFACT")"
  sha256sum -c "$(basename "$ARTIFACT").sha256"
)

verify_artifact_signature "$ARTIFACT"

id "$SERVICE" >/dev/null 2>&1 || fail 'service user is missing'

ENV_FILE="$ROOT/config/gateway.env"
validate_production_config "$ENV_FILE"

install -d -o root -g "$SERVICE" -m 0750 "$ROOT" "$ROOT/releases" "$ROOT/config"
install -d -o "$SERVICE" -g "$SERVICE" -m 0750 "$ROOT/data" "$ROOT/data/attachments" "$ROOT/data/backups" "$ROOT/logs" "$ROOT/runtime"

if [[ -L $ROOT/current && -z $(resolve_current) ]]; then
  echo 'removing unusable current symlink' >&2
  rm -f "$ROOT/current"
fi

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
for page in admin member chat login; do
  [[ -f $RELEASE/dist/public/$page.html ]] || fail "console entry missing from release: $page.html"
done

install_production_dependencies "$RELEASE" "$SERVICE" "$NPM_INSTALL_PATH" /usr/sbin/runuser /usr/bin/chown

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

run_preflight "$RELEASE"

PREVIOUS=$(resolve_current)
CANDIDATE_LINK="$ROOT/.current-$SHA"
ln -s "$RELEASE" "$CANDIDATE_LINK"
mv -Tf "$CANDIDATE_LINK" "$ROOT/current"

sync_unit "$RELEASE"
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
