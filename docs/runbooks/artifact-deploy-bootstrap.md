# Verified deploy bootstrap from an immutable artifact

Use this recovery path only when the deploy entrypoint in the active release fails `bash -n`. It does not authorize a host hotfix: the executed entrypoint is extracted from a newly merged, workstation-authorized immutable artifact and verified against both its outer checksum and inner manifest.

An SHA whose deploy invocation already failed is abandoned. Build and transfer a new merged SHA before using this procedure.

## Preconditions

- The new SHA passed PR diagnostics and the full operator workstation release gate.
- Only `<sha>.tar.gz` and `<sha>.tar.gz.sha256` were transferred to `/tmp`.
- `/opt/leuwongrr-gateway/config/gateway.env` remains root-owned mode 600.
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
sudo test ! -e "/opt/leuwongrr-gateway/releases/$SHA"
```

If the checksum fails or the release directory exists, stop and abandon this SHA.

Extract only the canonical deploy entrypoint, then verify its bytes against the manifest inside the already-verified artifact:

```bash
tar -xOf "$ARTIFACT" ./scripts/deploy.sh > "$ENTRYPOINT"
chmod 0700 "$ENTRYPOINT"
EXPECTED=$(tar -xOf "$ARTIFACT" ./manifest.sha256 | awk '$2 == "./scripts/deploy.sh" { print $1 }')
ACTUAL=$(sha256sum "$ENTRYPOINT" | awk '{ print $1 }')
[[ -n $EXPECTED && $ACTUAL == "$EXPECTED" ]]
```

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
