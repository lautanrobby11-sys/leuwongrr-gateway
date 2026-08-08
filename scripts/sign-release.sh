#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# A16: sign the release checksum with the operator's dedicated Ed25519 key so a
# host can tell an authentic artifact from a forged one. The .sha256 file is the
# signed object: it is small, canonical, and (A14) a pure function of the commit,
# so the signature binds the tarball by content without hashing it a second time.
# Ed25519 is deterministic, so two runs over the same .sha256 produce
# byte-identical .sig files.
#
# CI never runs this script: it has no private key and its artifacts are never
# deployed (runbook boundary; ADR-012). The private key lives only on the
# operator workstation with off-host custody (docs/runbooks/operations.md age
# custody pattern); the public half lives in keys/release-signers and on the
# host at /opt/leuwongrr-gateway/config/release-signers (ADR-013).
#
# OpenSSH -Y sign writes the signature to <file>.sig next to the input.
# deploy.sh verifies with `-Y verify ... < <file>` because OpenSSH 9.6/10.x
# -Y verify reads the message from stdin and ignores a positional file argument.

SHA=${1:-}
SIGN_KEY=${SIGN_KEY:-$HOME/.ssh/leuwongrr-release-signer}
SIGNER_PRINCIPAL=${SIGNER_PRINCIPAL:-release-signer}
readonly NAMESPACE=file

[[ $SHA =~ ^[0-9a-f]{40}$ ]] || { echo 'full git SHA required' >&2; exit 1; }

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ART="$SCRIPT_DIR/../.release/$SHA.tar.gz"
[[ -f $ART ]] || { echo "artifact missing: $ART (run scripts/build-release.sh first)" >&2; exit 1; }
[[ -f $ART.sha256 ]] || { echo "checksum missing: $ART.sha256" >&2; exit 1; }
[[ -f $SIGN_KEY ]] || {
  echo "signing key missing: $SIGN_KEY" >&2
  echo 'generate once with: ssh-keygen -t ed25519 -N "" -C leuwongrr-release-signer -f "$SIGN_KEY"' >&2
  exit 1
}
command -v ssh-keygen >/dev/null 2>&1 || { echo 'ssh-keygen required' >&2; exit 1; }

ssh-keygen -Y sign -f "$SIGN_KEY" -n "$NAMESPACE" "$ART.sha256" >/dev/null 2>&1

ssh-keygen -lf "$SIGN_KEY.pub"
echo "signed: $ART.sha256.sig"
