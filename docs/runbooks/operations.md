# Operations runbook

## Preconditions
- Operator has VPS root and Cloudflare authority; no secret is pasted into Git/Notion/log.
- `/opt/leuwongrr-gateway/config/gateway.env` is root-owned mode 600.
- `leuwongrr-gateway` service user exists without login shell.
- Baseline CPU/RSS/disk/FD/OmniRoute latency and SSH responsiveness are recorded before choosing final systemd limits.

## Validate and release
1. Clean checkout: `git status --short`, `npm install`, `npm run validate`, `npm run build`.
2. Review diff and secret scan. Build tar from committed SHA only; create SHA-256 sidecar.
3. `sudo scripts/deploy.sh <40-char-sha> <artifact.tar.gz>`.
4. Record SHA, changed canonical files, migration `0001_gateway_core`, validation result, health, resource snapshot, and prior release SHA.

## Post-deploy negative checks
- `ss -ltnp`: Gateway only `127.0.0.1:2080`; OmniRoute only expected loopback port.
- Unknown route returns 404 and produces no OmniRoute request.
- `/v1/models` without/invalid key returns 401; wrong scope returns 403.
- `/health/ready` without internal token returns 404.
- `/admin*`: missing/forged/expired Access JWT fails; valid Access identity without application role fails.
- `/v1` and `/v1beta` never redirect to Cloudflare interactive login.
- Check `systemctl show leuwongrr-gateway` resource limits and `journalctl` redaction.

## Backup/restore
Run `scripts/backup.sh` with an age recipient. Verify using `scripts/restore-drill.sh <backup> <identity>` in a temporary directory. This uses SQLite online backup and validates checksum, integrity, and foreign keys. Never copy a live WAL database directly.

## Rollback
`sudo scripts/rollback.sh <previous-40-char-sha>`. It atomically moves `current`, restarts, and requires liveness; an unhealthy rollback target restores the original symlink. Forward-only migrations use expand/migrate/contract; do not invent down migrations.

## Status discipline
Do not mark production DONE until Cloudflare, tenant isolation, load/overload, backup restore, and rollback have real captured outputs. Repository CI alone proves only repository gates.