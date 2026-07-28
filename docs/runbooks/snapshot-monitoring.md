# Snapshot dead-man monitoring

The local timer proves only that systemd intends to run a snapshot. An external dead-man check proves that successful snapshots continue to arrive even when the VPS, timer, backup toolchain, DNS, or outbound network fails.

## Design

After `backup.sh` creates the encrypted archive, writes its checksum, applies permissions, and completes retention, it sends one HTTPS success ping. The external monitor expects one ping every 24 hours with a 12-hour grace period. A missing ping therefore alerts when the latest successful snapshot is approximately 36 hours old.

The ping URL is a bearer capability. It belongs only in `/opt/leuwongrr-gateway/config/gateway.env` as root-owned mode 600. Never store it in Git, Notion, screenshots, shell history, or raw logs.

Any HTTPS dead-man service that alerts to the operator's email may be used. Do not self-host the monitor on the same VPS; that would fail silently with the system it watches.

## Activation

1. Create the external check with period 24 hours and grace 12 hours.
2. Configure an operator email notification at the external service.
3. Deploy the release containing `scripts/ping-snapshot-healthcheck.sh` through the normal immutable release path.
4. Add the real URL directly on the VPS without printing it:

```bash
sudoedit /opt/leuwongrr-gateway/config/gateway.env
# SNAPSHOT_HEALTHCHECK_URL=https://...
```

5. Prove the full path after deploy:

```bash
sudo systemctl start leuwongrr-gateway-snapshot.service
sudo systemctl show leuwongrr-gateway-snapshot.service \
  -p Result -p ExecMainStatus --no-pager
sudo journalctl -u leuwongrr-gateway-snapshot.service -n 20 --no-pager
```

Expected sanitized output includes `snapshot healthcheck notified`, `Result=success`, and `ExecMainStatus=0`. Verify separately in the external service UI that the ping arrived and that the next deadline is approximately 36 hours away.

## Failure behavior

- Missing URL: backup succeeds but logs `snapshot monitoring disabled`; API-only go-live remains NO-GO.
- Non-HTTPS URL: snapshot unit fails closed after writing the valid archive.
- Ping failure: snapshot unit is failed and the external monitor receives no success ping, so it alerts after the grace window.
- Backup failure before archive/checksum completion: no ping is sent.

A failed notification does not delete the newly created archive and never stops the Gateway service. Do not mark the alert gate PASS until a controlled missed-ping notification has been received by the operator.