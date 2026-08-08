# ADR-013: Release artifact signing with OpenSSH signatures

- Status: Accepted
- Date: 2026-08-08

## Context

Release artifacts are checksummed but not signed (audit finding A16). The `.sha256`
file travels beside the tarball, so it detects corruption but not forgery: an
attacker who can intercept or replace both files can ship arbitrary content that
still verifies. The artifact is already reproducible from its commit (A14), so a
signature over the checksum is a pure function of the commit given a fixed key —
the same property that made checksumming meaningful is what makes a signature
worth attaching now.

Constraints inherited from ADR-012 and the operator runbook:

- CI has no private key and its artifacts are never deployed; signing must be an
  operator-local step, not part of `scripts/build-release.sh`.
- The VPS "receives only the artifact and checksum ... Do not copy the
  repository, `.git`, `node_modules`, local environment files, or private keys"
  (`docs/runbooks/operator-release-authority.md`). The private key stays on the
  operator workstation; only public material crosses to the host.
- No new host dependencies. The host already carries the OpenSSH client
  (`ssh-keygen`); the operator workstation carries it through Git for Windows.
- Signature verification must fail closed: a missing or invalid signature blocks
  the deploy, matching how a missing checksum blocks it today.

## Decision

1. Release artifacts are signed by the operator with a dedicated Ed25519 key
   (`ssh-keygen -Y sign`, namespace `file`). The signed object is the `.sha256`
   file; the signature is written to `<sha>.tar.gz.sha256.sig` in `.release/`.
2. Signing is a separate operator step, `scripts/sign-release.sh <sha>`, run
   after `scripts/build-release.sh` and never in CI. Ed25519 signatures are
   deterministic: two runs over the same `.sha256` produce byte-identical `.sig`
   files, so the signature does not weaken A14 reproducibility.
3. The public key is stored in `keys/release-signers` (OpenSSH allowed_signers
   format) in the repository and on the host at
   `/opt/leuwongrr-gateway/config/release-signers` (root:root 0644). The host
   file is the trust anchor: `deploy.sh` refuses an artifact whose signature does
   not verify against it, so a swapped signers file cannot validate an
   attacker-signed artifact and a missing signature always fails closed.
4. `scripts/deploy.sh` verifies the signature after the outer checksum and
   before extraction: `ssh-keygen -Y verify -f $RELEASE_SIGNERS
   -I release-signer -n file -s <sig> < <sha256-file>`. The checksum is fed on
   stdin because OpenSSH 9.6/10.x `-Y verify` reads the message from stdin and
   ignores a positional file argument.
5. The artifact also carries `keys/release-signers` so a bare-host bootstrap
   (`scripts/vps-bootstrap.sh`) can seed the host trust anchor once. An existing
   host file is never overwritten: a key rotated by the operator is
   authoritative.
6. Rollback keeps its A18 manifest checksum; the artifact signature is consumed
   at deploy time, when the tarball still exists. A release directory that was
   authentic at deploy time is a valid rollback target. A forged release
   directory created after host compromise is out of scope: the same compromise
   could replace the host trust anchor itself.
7. Key custody follows the age-identity pattern: the private key
   (`~/.ssh/leuwongrr-release-signer`) lives on the operator workstation with
   off-host backups; the public fingerprint is part of release evidence.
   Rotation is a PR updating `keys/release-signers` plus an operator update of
   the host file; the signature of the next release is bound to the new key.

## Consequences

- A forged or substituted artifact now fails verification on the host instead of
  passing a checksum that travels with the attacker's content.
- Deploy requires one more operator step (sign) and one more file in the
  transfer (`.sig`); the runbook transfer boundary and workstation gate are
  updated accordingly.
- The operator holds a production signing key; its custody is now a production
  concern on par with the age backup identity.
- CI remains keyless and unchanged: its checksum-only artifacts are evidence,
  never deployable input.
