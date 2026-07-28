#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
SHA=${1:-$(git rev-parse HEAD)}
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || { echo 'full git SHA required' >&2; exit 1; }
[[ -z $(git status --porcelain --untracked-files=no) ]] || { echo 'tracked working tree must be clean' >&2; exit 1; }
npm run build
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p .release "$STAGE/dist"
cp -a dist/. "$STAGE/dist/"
cp package.json "$STAGE/package.json"
[[ -f package-lock.json ]] && cp package-lock.json "$STAGE/package-lock.json"
printf 'git_sha=%s\nbuilt_at=%s\nnode=%s\n' "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(node --version)" > "$STAGE/RELEASE"
(
  cd "$STAGE"
  find . -type f -print0 | sort -z | xargs -0 sha256sum > manifest.sha256
)
# Portable archive: avoid GNU-only tar flags that break on some runners.
tar -C "$STAGE" -czf ".release/$SHA.tar.gz" .
(
  cd .release
  sha256sum "$SHA.tar.gz" > "$SHA.tar.gz.sha256"
)
echo ".release/$SHA.tar.gz"
