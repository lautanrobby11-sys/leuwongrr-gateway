#!/usr/bin/env bash
set -Eeuo pipefail
umask 022
SHA=${1:-$(git rev-parse HEAD)}
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || { echo 'full git SHA required' >&2; exit 1; }
HEAD_SHA=$(git rev-parse HEAD)
[[ $SHA == "$HEAD_SHA" ]] || {
  echo "requested SHA $SHA does not match checked-out HEAD $HEAD_SHA" >&2
  exit 1
}
# Resolved from this file so the assertion comes from the same checkout as the
# build being run, the same reason backup.sh resolves its own ping script.
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
CLEAN_TREE="$SCRIPT_DIR/assert-clean-tree.sh"
# Preflight: fail before spending a build and a package on a tree that cannot
# produce a reproducible artifact. The same assertion runs again at the end.
bash "$CLEAN_TREE" preflight

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
# vps-bootstrap.sh ships even though it runs before the first deploy: copying the
# repository to the VPS is forbidden, so the artifact is the only path by which
# the documented host-prep script can reach the host.
cp scripts/deploy.sh scripts/rollback.sh scripts/backup.sh scripts/restore-drill.sh \
  scripts/ping-snapshot-healthcheck.sh scripts/vps-bootstrap.sh "$STAGE/scripts/"
# Every unit the runbook tells the operator to install must ship in the
# artifact. The snapshot timer is installed from current/infra/systemd, so a
# release that omits it turns the documented command into "No such file or
# directory" on a host that is otherwise perfectly deployed.
for unit in leuwongrr-gateway.service leuwongrr-gateway-snapshot.service leuwongrr-gateway-snapshot.timer; do
  [[ -f infra/systemd/$unit ]] || { echo "unit missing from repository: infra/systemd/$unit" >&2; exit 1; }
  cp "infra/systemd/$unit" "$STAGE/infra/systemd/"
done
# A16: ship the current release signers so a bare-host bootstrap can seed
# /opt/leuwongrr-gateway/config/release-signers from the artifact. The host file
# is the trust anchor for deploy-time signature verification; the copy inside
# the artifact only bootstraps that anchor on first install.
[[ -f keys/release-signers ]] || { echo 'keys/release-signers missing from repository' >&2; exit 1; }
mkdir -p "$STAGE/keys"
cp keys/release-signers "$STAGE/keys/"

# Git for Windows may expose CRLF in an existing checkout even after policy is
# added. Normalize only the staged release copy, then reject any remaining CR
# byte. Linux must never receive shell scripts or systemd units with CRLF.
while IFS= read -r -d '' critical_file; do
  sed -i 's/\r$//' "$critical_file"
  if LC_ALL=C grep -q $'\r' "$critical_file"; then
    echo "release-critical file contains carriage return: $critical_file" >&2
    exit 1
  fi
done < <(find "$STAGE/scripts" "$STAGE/infra/systemd" -type f -print0)
bash -n "$STAGE/scripts/"*.sh
chmod 0755 "$STAGE/scripts/"*.sh
# The operator key CLI ships as part of dist so issuance always matches the
# running service instead of a separate copy of the hashing rules.
[[ -f $STAGE/dist/cli/keys.js ]] || { echo 'operator key CLI missing from build output' >&2; exit 1; }
# A14: every value written here must be a function of the commit, never of the
# machine or the moment. `built_at=$(date -u ...)` used to sit in this record and
# was the reason two builds of one commit produced two different tarball
# checksums: it changed the RELEASE bytes, which changed the RELEASE entry in
# manifest.sha256, which changed the archive. The commit's own committer date
# carries the same "when" without that drift, so it replaces it under a name that
# says what it actually is. The node line is a function of the commit too: it is
# the major from package.json's committed `engines.node`, not `node --version`,
# which is the building machine speaking and would give one commit two checksums
# as soon as an operator rebuilt on a different patch level (the current VPS is
# already one patch behind the workstation toolchain).
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct "$SHA")
[[ $SOURCE_DATE_EPOCH =~ ^[0-9]+$ ]] || { echo "cannot resolve committer date for $SHA" >&2; exit 1; }
NODE_ENGINE_MAJOR=$(sed -n 's/.*"node"[[:space:]]*:[[:space:]]*">=[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$STAGE/package.json" | head -n1)
[[ -n $NODE_ENGINE_MAJOR ]] || { echo 'cannot read engines.node from package.json' >&2; exit 1; }
printf 'git_sha=%s\ncommitted_at=%s\nnode=v%s\nconsole=admin,member,chat,login\n' \
  "$SHA" "$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ)" "$NODE_ENGINE_MAJOR" > "$STAGE/RELEASE"
# Normalize the staged modes before anything hashes or archives them. A checkout
# under a different umask would otherwise ship the same bytes under different
# permission bits and produce a different archive. deploy.sh extracts with
# --no-same-owner --no-same-permissions, so this cannot change what production
# ends up running.
find "$STAGE" -type d -exec chmod 0755 {} +
find "$STAGE" -type f -exec chmod 0644 {} +
chmod 0755 "$STAGE/scripts/"*.sh
# The manifest must not list itself. Redirection creates and truncates
# manifest.sha256 before find runs, so a self-entry records the checksum of an
# empty file and deploy.sh then rejects every artifact with one mismatch.
# LC_ALL=C so the sort order is the same on an operator workstation with any
# locale as it is on the CI runner; a collating difference would reorder the
# manifest lines and change its checksum without any file having changed.
(
  cd "$STAGE"
  find . -type f ! -path ./manifest.sha256 -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > manifest.sha256
)
# A14: --sort=name fixes member order, --owner/--group/--numeric-owner strip the
# building account (it was recorded as the operator's own uid), --mtime pins every
# timestamp to the commit, and gzip -n omits the name and timestamp that the
# compressor would otherwise stamp into its own header. Without all four, one
# commit had two checksums and the .sha256 file bound the artifact to nothing more
# than the particular run that happened to produce it.
tar --sort=name --format=gnu \
  --owner=0 --group=0 --numeric-owner \
  --mtime="@$SOURCE_DATE_EPOCH" \
  -C "$STAGE" -cf - . | gzip -n -9 > ".release/$SHA.tar.gz"
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
  bash -n scripts/*.sh
  while IFS= read -r -d '' critical_file; do
    if LC_ALL=C grep -q $'\r' "$critical_file"; then
      echo "verified artifact contains carriage return: $critical_file" >&2
      exit 1
    fi
  done < <(find scripts infra/systemd -type f -print0)
)
# Post-package: the same canonical assertion, so `npm run ci:local` proves that
# building, staging, packaging and checksumming did not modify a tracked file or
# leave an unexpected non-ignored file behind. Without this the workstation gate
# only ever checked the tree it started with, while GitHub Actions checked the
# tree it ended with, and the two gates named `clean` meant different things.
bash "$CLEAN_TREE" 'after packaging'
echo ".release/$SHA.tar.gz"
