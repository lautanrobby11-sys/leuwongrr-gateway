#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT=/opt/leuwongrr-gateway
SHA=${1:-}
ARTIFACT=${2:-}
[[ $EUID -eq 0 ]] || { echo 'deploy must run as root' >&2; exit 1; }
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || { echo 'full git SHA required' >&2; exit 1; }
[[ -f $ARTIFACT && -f ${ARTIFACT}.sha256 ]] || { echo 'artifact and .sha256 required' >&2; exit 1; }
sha256sum -c "${ARTIFACT}.sha256"
id leuwongrr-gateway >/dev/null
install -d -o root -g leuwongrr-gateway -m 0750 "$ROOT" "$ROOT/releases" "$ROOT/config"
install -d -o leuwongrr-gateway -g leuwongrr-gateway -m 0750 "$ROOT/data" "$ROOT/data/attachments" "$ROOT/data/backups" "$ROOT/logs" "$ROOT/runtime"
[[ -f $ROOT/config/gateway.env ]] || { echo 'missing config/gateway.env' >&2; exit 1; }
[[ $(stat -c %a "$ROOT/config/gateway.env") == 600 ]] || { echo 'gateway.env must be mode 600' >&2; exit 1; }
RELEASE="$ROOT/releases/$SHA"
[[ ! -e $RELEASE ]] || { echo 'immutable release already exists' >&2; exit 1; }
mkdir -m 0750 "$RELEASE"
tar --extract --file "$ARTIFACT" --directory "$RELEASE" --no-same-owner --no-same-permissions
chown -R root:leuwongrr-gateway "$RELEASE"; chmod -R u=rwX,g=rX,o= "$RELEASE"
runuser -u leuwongrr-gateway -- env $(grep -v '^#' "$ROOT/config/gateway.env" | xargs) node "$RELEASE/dist/preflight.js"
PREVIOUS=$(readlink -f "$ROOT/current" 2>/dev/null || true)
ln -s "$RELEASE" "$ROOT/.current-$SHA"; mv -Tf "$ROOT/.current-$SHA" "$ROOT/current"
if ! systemctl restart leuwongrr-gateway || ! timeout 30 bash -c 'until curl -fsS http://127.0.0.1:2080/health/live >/dev/null; do sleep 1; done'; then
  [[ -n $PREVIOUS ]] && { ln -s "$PREVIOUS" "$ROOT/.rollback"; mv -Tf "$ROOT/.rollback" "$ROOT/current"; systemctl restart leuwongrr-gateway; }
  echo 'deployment failed and previous symlink restored' >&2; exit 1
fi
printf '%s\n' "$SHA" > "$ROOT/runtime/active-sha"
echo "deployed $SHA; previous=${PREVIOUS:-none}"
