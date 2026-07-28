#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
SHA=${1:-$(git rev-parse HEAD)}
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || { echo 'full git SHA required' >&2; exit 1; }
[[ -z $(git status --porcelain --untracked-files=no) ]] || { echo 'tracked working tree must be clean' >&2; exit 1; }
npm run validate
npm run build
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
install -d "$STAGE/dist" "$STAGE/node_modules" .release
cp -a dist/. "$STAGE/dist/"
cp package.json "$STAGE/package.json"
cp -a node_modules/. "$STAGE/node_modules/"
( cd "$STAGE" && npm prune --omit=dev --no-audit --no-fund )
( cd "$STAGE" && npm sbom --omit=dev --sbom-format=spdx > sbom.spdx.json )
tar -C "$STAGE" --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner -czf ".release/$SHA.tar.gz" dist node_modules package.json sbom.spdx.json
( cd .release && sha256sum "$SHA.tar.gz" > "$SHA.tar.gz.sha256" )
echo ".release/$SHA.tar.gz"
