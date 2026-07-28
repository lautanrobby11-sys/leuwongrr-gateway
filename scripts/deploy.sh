#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT=/opt/leuwongrr-gateway
SHA=${1:-}
ARTIFACT=${2:-}
[[ $EUID -eq 0 ]] || { echo 'deploy must run as root' >&2; exit 1; }
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || { echo 'full git SHA required' >&2; exit 1; }
[[ -f $ARTIFACT && -f ${ARTIFACT}.sha256 ]] || { echo 'artifact and .sha256 required' >&2; exit 1; }
( cd "$(dirname "$ARTIFACT")" && sha256sum -c "$(basename "$ARTIFACT").sha256" )
id leuwongrr-gateway >/dev/null
install -d -o root -g leuwongrr-gateway -m 0750 "$ROOT" "$ROOT/releases" "$ROOT/config"
install -d -o leuwongrr-gateway -g leuwongrr-gateway -m 0750 "$ROOT/data" "$ROOT/data/attachments" "$ROOT/data/backups" "$ROOT/logs" "$ROOT/runtime"
[[ -f $ROOT/config/gateway.env ]] || { echo 'missing config/gateway.env' >&2; exit 1; }
[[ $(stat -c %a "$ROOT/config/gateway.env") == 600 ]] || { echo 'gateway.env must be mode 600' >&2; exit 1; }
RELEASE="$ROOT/releases/$SHA"
[[ ! -e $RELEASE ]] || { echo 'immutable release already exists' >&2; exit 1; }
mkdir -m 0750 "$RELEASE"
tar --extract --file "$ARTIFACT" --directory "$RELEASE" --no-same-owner --no-same-permissions
( cd "$RELEASE" && sha256sum -c manifest.sha256 >/dev/null )
if [[ -f $RELEASE/package-lock.json ]]; then ( cd "$RELEASE" && npm ci --omit=dev --no-audit --no-fund ); else ( cd "$RELEASE" && npm install --omit=dev --no-audit --no-fund ); fi
chown -R root:leuwongrr-gateway "$RELEASE"; chmod -R u=rwX,g=rX,o= "$RELEASE"
set -a; . "$ROOT/config/gateway.env"; set +a
runuser -u leuwongrr-gateway -- node "$RELEASE/dist/preflight.js"
PREVIOUS=$(readlink -f "$ROOT/current" 2>/dev/null || true)
ln -s "$RELEASE" "$ROOT/.current-$SHA"; mv -Tf "$ROOT/.current-$SHA" "$ROOT/current"
if ! systemctl restart leuwongrr-gateway || ! timeout 30 bash -c 'until curl -fsS http://127.0.0.1:2080/health/live >/dev/null; do sleep 1; done'; then
  if [[ -n $PREVIOUS ]]; then ln -s "$PREVIOUS" "$ROOT/.rollback"; mv -Tf "$ROOT/.rollback" "$ROOT/current"; systemctl restart leuwongrr-gateway; fi
  echo 'deployment failed and previous symlink restored' >&2; exit 1
fi
printf '%s\n' "$SHA" > "$ROOT/runtime/active-sha"
echo "deployed $SHA; previous=${PREVIOUS:-none}"
