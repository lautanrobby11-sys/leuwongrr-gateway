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
trap 'rm -rf "$STAGE"' EXIT
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
cp infra/systemd/leuwongrr-gateway.service "$STAGE/infra/systemd/"
chmod 0755 "$STAGE/scripts/"*.sh
# The operator key CLI ships as part of dist so issuance always matches the
# running service instead of a separate copy of the hashing rules.
[[ -f $STAGE/dist/cli/keys.js ]] || { echo 'operator key CLI missing from build output' >&2; exit 1; }
printf 'git_sha=%s\nbuilt_at=%s\nnode=%s\nconsole=admin,member,chat,login\n' \
  "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(node --version)" > "$STAGE/RELEASE"
(
  cd "$STAGE"
  find . -type f -print0 | sort -z | xargs -0 sha256sum > manifest.sha256
)
tar -C "$STAGE" -czf ".release/$SHA.tar.gz" .
(
  cd .release
  sha256sum "$SHA.tar.gz" > "$SHA.tar.gz.sha256"
)
echo ".release/$SHA.tar.gz"
