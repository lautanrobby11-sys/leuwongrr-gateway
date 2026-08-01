#!/usr/bin/env bash
set -Eeuo pipefail

# Canonical clean-tree assertion. There is exactly one implementation:
# scripts/build-release.sh calls it before the build and again after packaging
# and checksumming, and the `clean` step in .github/workflows/quality.yml calls
# this same file. Two hand-written shell blocks drifted apart before — the
# workstation checked only before the build while GitHub Actions checked only
# after packaging — so `npm run ci:local` and Actions did not enforce the same
# thing despite both being named `clean`.
#
# Untracked files count. Packaging stages from the working tree rather than from
# `git archive <sha>`, so an untracked file under src/, scripts/ or web/ is
# compiled into dist/ and shipped inside the artifact while being absent from
# the commit the release evidence names, and absent from a fresh clone of it,
# which makes the artifact unreproducible. The post-package call additionally
# proves that building, staging, and checksumming did not modify a tracked file
# or leave a new non-ignored file behind.
#
# Generated output already covered by the canonical ignores (dist/, .release/,
# data/) is not reported by --porcelain, so the build's own output does not trip
# the check. Nothing is ever added to .gitignore to satisfy it: an offending
# file is committed or deleted.
STAGE=${1:-"working tree"}

DIRTY=$(git status --porcelain)
if [[ -n $DIRTY ]]; then
  echo "working tree must be clean ($STAGE), including untracked files:" >&2
  printf '%s\n' "$DIRTY" >&2
  echo 'commit them, delete them, or add them to .gitignore, then re-run' >&2
  exit 1
fi
