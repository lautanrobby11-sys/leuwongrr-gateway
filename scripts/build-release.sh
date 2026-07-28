#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
SHA=${1:-$(git rev-parse HEAD)}
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || { echo 'full git SHA required' >&2; exit 1; }
[[ -z $(git status --porcelain --untracked-files=no) ]] || { echo 'tracked working tree must be clean' >&2; exit 1; }

# The console is part of the product, not an optional extra: a backend-only
# artifact would pass health checks while every dashboard returned 503.
npm run build:all

for page in admin member chat login; do
  [[ -f dist/public/$page.html ]] || { echo "console entry missing: dist/public/$page.html" >&2; exit 1; }
done
[[ -d dist/public/assets ]] || { echo 'console assets directory missing: dist/public/assets' >&2; exit 1; }

STAGE=$(mktemp -d)
VERIFY=$(mktemp -d)
trap 'rm -rf "$STAGE" "$VERIFY"' EXIT
mkdir -p .release "$STAGE/dist" "$STAGE/scripts" "$STAGE/infra/systemd" "$STAGE/web"
cp -a dist/. "$STAGE/dist/"
cp package.json "$STAGE/package.json"
cp web/package.json "$STAGE/web/package.json"
# Written as if-blocks on purpose: under `set -e` a bare `[[ ... ]] && cp ...`
# aborts the whole script whenever the lockfile is absent.
if [[ -f package-lock.json ]]; then
  cp package-lock.json "$STAGE/package-lock.json"
fi
if [[ -f web/package-lock.json ]]; then
  cp web/package-lock.json "$STAGE/web/package-lock.json"
fi
cp scripts/deploy.sh scripts/rollback.sh scripts/backup.sh scripts/restore-drill.sh "$STAGE/scripts/"
# Every unit the runbook tells the operator to install must ship in the
# artifact. The snapshot timer is installed from current/infra/systemd, so a
# release that omits it turns the documented command into "No such file or
# directory" on a host that is otherwise perfectly deployed.
for unit in leuwongrr-gateway.service leuwongrr-gateway-snapshot.service leuwongrr-gateway-snapshot.timer; do
  [[ -f infra/systemd/$unit ]] || { echo "unit missing from repository: infra/systemd/$unit" >&2; exit 1; }
  cp "infra/systemd/$unit" "$STAGE/infra/systemd/"
done
chmod 0755 "$STAGE/scripts/"*.sh
# The operator key CLI ships as part of dist so issuance always matches the
# running service instead of a separate copy of the hashing rules.
[[ -f $STAGE/dist/cli/keys.js ]] || { echo 'operator key CLI missing from build output' >&2; exit 1; }
printf 'git_sha=%s\nbuilt_at=%s\nnode=%s\nconsole=admin,member,chat,login\n' \
  "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(node --version)" > "$STAGE/RELEASE"
# The manifest must not list itself. Redirection creates and truncates
# manifest.sha256 before find runs, so a self-entry records the checksum of an
# empty file and deploy.sh then rejects every artifact with one mismatch.
(
  cd "$STAGE"
  find . -type f ! -path ./manifest.sha256 -print0 | sort -z | xargs -0 sha256sum > manifest.sha256
)
tar -C "$STAGE" -czf ".release/$SHA.tar.gz" .
(
  cd .release
  sha256sum "$SHA.tar.gz" > "$SHA.tar.gz.sha256"
)
# Verify the finished artifact the same way deploy.sh will. Checking only the
# outer tarball checksum proves the download is intact, not that the manifest
# inside it describes the files it ships with.
tar -C "$VERIFY" -xzf ".release/$SHA.tar.gz"
(
  cd "$VERIFY"
  sha256sum -c manifest.sha256 >/dev/null
)
echo ".release/$SHA.tar.gz"
