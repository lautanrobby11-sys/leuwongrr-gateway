# Verified deploy bootstrap from an immutable artifact

Two procedures share one rule: every script root executes on the host is extracted from a verified artifact, never copied from a checkout.

- **Verify and extract** / **Activate once** below: recovery path, used only when the deploy entrypoint in the active release fails `bash -n`.
- **First deploy on a bare host**: host preparation before any release directory exists.

Use the recovery path only when the deploy entrypoint in the active release fails `bash -n`. It does not authorize a host hotfix: the executed entrypoint is extracted from a newly merged, workstation-authorized immutable artifact and verified against both its outer checksum and inner manifest.

An SHA whose deploy invocation already failed is abandoned. Build and transfer a new merged SHA before using this procedure.

## Preconditions

- The new SHA passed PR diagnostics and the full operator workstation release gate.
- Only `<sha>.tar.gz`, `<sha>.tar.gz.sha256`, and `<sha>.tar.gz.sha256.sig` were transferred to `/tmp`.
- `/opt/leuwongrr-gateway/config/gateway.env` remains root-owned mode 600.
- `/opt/leuwongrr-gateway/config/release-signers` holds the operator's release-signer public key (seeded at first bootstrap, rotated directly on the host; see ADR-013).
- No release directory exists for the new SHA.

## Verify and extract

Run on the VPS as the `ubuntu` login user. Replace the placeholder once; do not use the previously attempted SHA.

```bash
SHA=<new-full-40-character-sha>
ARTIFACT="/tmp/$SHA.tar.gz"
CHECKSUM="$ARTIFACT.sha256"
ENTRYPOINT="/tmp/leuwongrr-deploy-$SHA.sh"
```

Verify the transferred artifact before extracting executable content:

```bash
(
  cd /tmp
  sha256sum -c "$(basename "$CHECKSUM")"
)
ssh-keygen -Y verify -f /opt/leuwongrr-gateway/config/release-signers \
  -I release-signer -n file -s "$CHECKSUM.sig" < "$CHECKSUM"
sudo test ! -e "/opt/leuwongrr-gateway/releases/$SHA"
```

If the checksum or the signature fails, or the release directory exists, stop and abandon this SHA.

Extract only the canonical deploy entrypoint, then verify its bytes against the manifest inside the already-verified artifact:

```bash
tar -xOf "$ARTIFACT" ./scripts/deploy.sh > "$ENTRYPOINT"
chmod 0700 "$ENTRYPOINT"
EXPECTED=$(tar -xOf "$ARTIFACT" ./manifest.sha256 |
  awk '{ sub(/^\*/, "", $2); if ($2 == "./scripts/deploy.sh") print $1 }')
ACTUAL=$(sha256sum "$ENTRYPOINT" | awk '{ print $1 }')
[[ -n $EXPECTED && $ACTUAL == "$EXPECTED" ]]
```

The `sub(/^\*/, ...)` is not cosmetic: `sha256sum` defaults to binary mode on
Windows, so an artifact packaged on a Windows workstation writes one space and
then `*./path`, where a Linux build writes two spaces and then `./path`. `awk`
collapses runs of whitespace, so `$2` is `*./path` in the first case and
`./path` in the second; the marker travels with the field. A plain `$2 ==`
comparison silently finds nothing and the guard then fails on an artifact that
is actually intact.

Prove Linux syntax and line endings before root executes anything:

```bash
bash -n "$ENTRYPOINT"
CR_BYTES=$(tr -cd '\r' < "$ENTRYPOINT" | wc -c)
printf 'deploy_entrypoint_carriage_returns=%s\n' "$CR_BYTES"
[[ $CR_BYTES -eq 0 ]]
```

Expected output is `deploy_entrypoint_carriage_returns=0`.

## Activate once

```bash
sudo bash "$ENTRYPOINT" "$SHA" "$ARTIFACT"
```

Do not repeat this command after any failure. Resolve the failure in source and authorize another SHA.

After a successful health-gated activation:

```bash
rm -f "$ENTRYPOINT"
sudo cat /opt/leuwongrr-gateway/runtime/active-sha
sudo systemctl show leuwongrr-gateway \
  -p ActiveState -p SubState -p NRestarts -p MemoryCurrent --no-pager
curl -sS -o /dev/null -w 'liveness=%{http_code}\n' \
  http://127.0.0.1:2080/health/live
```

The temporary entrypoint is executable staging, not configuration. It is deleted after success; no source checkout, Git credential, shadow unit, or environment copy is placed on the host.

## First deploy on a bare host

Host preparation before any release exists. `scripts/vps-bootstrap.sh` is staged into the artifact for exactly this reason: copying the repository to the VPS is forbidden, so the artifact is the only path by which the documented host-prep script reaches the host. It creates `/opt/leuwongrr-gateway`, the service user, the directory tree, a mode-600 `gateway.env` seed, seeds the release-signers trust anchor from the artifact's `keys/release-signers`, and installs the systemd unit. It does not start the service and does not deploy.

Preconditions: the SHA passed PR diagnostics and the full operator workstation release gate; only `<sha>.tar.gz`, `<sha>.tar.gz.sha256`, and `<sha>.tar.gz.sha256.sig` were transferred to `/tmp`; `/opt/leuwongrr-gateway` does not exist yet.

```bash
SHA=<new-full-40-character-sha>
ARTIFACT="/tmp/$SHA.tar.gz"
BOOTSTRAP="/tmp/leuwongrr-bootstrap-$SHA.sh"
UNIT="/tmp/leuwongrr-gateway-$SHA.service"
SIGNERS="/tmp/leuwongrr-signers-$SHA"
```

Verify the transferred artifact before extracting executable content:

```bash
(
  cd /tmp
  sha256sum -c "$SHA.tar.gz.sha256"
)
sudo test ! -e /opt/leuwongrr-gateway
```

If the checksum fails or the tree already exists, stop: an existing tree means this is not a first deploy.

Extract the bootstrap script and the unit it installs, then verify both against the manifest inside the already-verified artifact:

```bash
tar -xOf "$ARTIFACT" ./scripts/vps-bootstrap.sh > "$BOOTSTRAP"
tar -xOf "$ARTIFACT" ./infra/systemd/leuwongrr-gateway.service > "$UNIT"
tar -xOf "$ARTIFACT" ./keys/release-signers > "$SIGNERS"
chmod 0700 "$BOOTSTRAP"
chmod 0600 "$UNIT"
chmod 0600 "$SIGNERS"
for pair in "./scripts/vps-bootstrap.sh:$BOOTSTRAP" "./infra/systemd/leuwongrr-gateway.service:$UNIT" "./keys/release-signers:$SIGNERS"; do
  MEMBER=${pair%%:*}
  LOCAL=${pair#*:}
  EXPECTED=$(tar -xOf "$ARTIFACT" ./manifest.sha256 |
    awk -v m="$MEMBER" '{ sub(/^\*/, "", $2); if ($2 == m) print $1 }')
  ACTUAL=$(sha256sum "$LOCAL" | awk '{ print $1 }')
  [[ -n $EXPECTED && $ACTUAL == "$EXPECTED" ]] || { echo "manifest mismatch: $MEMBER" >&2; exit 1; }
done
```

The `sub(/^\*/, ...)` strips the binary-mode marker `sha256sum` writes when the
artifact was packaged on Windows: one space and then `*./path`, instead of the
two spaces and then `./path` a Linux build writes. The separator is whitespace
either way, so `awk` hands the marker to `$2` along with the path. Without the
`sub` the lookup returns nothing and the guard rejects an intact artifact.

Prove Linux syntax and line endings before root executes anything:

```bash
bash -n "$BOOTSTRAP"
CR_BYTES=$(tr -cd '\r' < "$BOOTSTRAP" | wc -c)
printf 'bootstrap_carriage_returns=%s\n' "$CR_BYTES"
[[ $CR_BYTES -eq 0 ]]
```

Expected output is `bootstrap_carriage_returns=0`.

Run it once, passing the verified unit as its argument:

```bash
sudo bash "$BOOTSTRAP" "$UNIT" "$SIGNERS"
```

Then substitute secrets in place and remove the staging copies:

```bash
sudo nano /opt/leuwongrr-gateway/config/gateway.env   # replace every REPLACE_ME
rm -f "$BOOTSTRAP" "$UNIT" "$SIGNERS"
```

`/opt/leuwongrr-gateway/config/release-signers` was seeded by the bootstrap from the signers file passed above, which itself was extracted from the artifact and verified against `manifest.sha256`. The signature of the transferred `.sig` is **not** verified during first bootstrap: no trust anchor exists yet. The operator establishes that anchor out-of-band by confirming the seeded fingerprint matches the release-signer key: `ssh-keygen -lf /opt/leuwongrr-gateway/config/release-signers`. Rotation never overwrites an existing file: the operator updates the host file directly, in the same commit that changes `keys/release-signers` in the repository.

The seed refuses to boot while any `REPLACE_ME` remains: each placeholder is shorter than the minimum its own schema rule enforces, so `loadConfig()` fails naming the field rather than starting in a half-configured state. Generate values with `openssl rand -hex 32`; never paste them into chat, Git, or Notion.

Only after `gateway.env` holds real values, continue with `## Activate once` above using the same `$ARTIFACT`. Credentials first, deploy second: `OMNIROUTE_API_KEY` must be real before `deploy.sh` runs, or the health gate fails and auto-restores against a symlink that does not exist yet.
