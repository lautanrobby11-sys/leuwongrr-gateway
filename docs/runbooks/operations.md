# Operations runbook

## Preconditions

- Operator has VPS root and Cloudflare authority; no secret is pasted into Git/Notion/log.
- `/opt/leuwongrr-gateway/config/gateway.env` is root-owned mode 600.
- `leuwongrr-gateway` service user exists without login shell.
- Baseline CPU/RSS/disk/FD/OmniRoute latency and SSH responsiveness are recorded before choosing final systemd limits.

## Developer / CI green path

1. Node 22 + `build-essential` + `python3` (native module `better-sqlite3`).
2. `npm install` then commit `package-lock.json` once so CI can use `npm ci`.
3. `npm run validate` must pass locally (conventions, offline secret scan, lint, typecheck, tests).
4. Optional full local mirror of CI: `npm run ci:local` (also builds the immutable release tarball).
5. Push to the PR branch and wait for workflow `quality` to finish green on the same SHA.
6. Merge only when the PR check is green. Repository CI alone does **not** mean production is ready.

```bash
git checkout feat/gateway-foundation
cp .env.example .env   # fill secrets locally only; never commit
npm install
git add package-lock.json
git commit -m "chore(deps): pin package-lock for deterministic CI"
npm run validate && npm run ci:local
git push origin feat/gateway-foundation
```

## First-time VPS bootstrap

```bash
# from a clean checkout of the release SHA on the VPS (or copy unit file)
sudo bash scripts/vps-bootstrap.sh infra/systemd/leuwongrr-gateway.service
# edit secrets in place — never paste them into chat/Git/Notion
sudo nano /opt/leuwongrr-gateway/config/gateway.env
# generate strong values, for example:
#   openssl rand -hex 32
```

## Validate and release

1. Clean checkout on the exact git SHA: `git status --short`, `npm ci` (or `npm install` if lockfile absent), `npm run validate`.
2. Review diff and secret scan. Run `scripts/build-release.sh <40-char-sha>` from that commit.
   - Emits `.release/<sha>.tar.gz` + `.release/<sha>.tar.gz.sha256`
   - Package contents: `dist/`, `package.json`, optional `package-lock.json`, `RELEASE`, `manifest.sha256`
3. Transfer only the artifact and checksum, then run `sudo scripts/deploy.sh <40-char-sha> <artifact.tar.gz>`.
4. Deploy verifies checksum + manifest, installs production dependencies on the server, runs preflight as the service user, atomically swaps `current`, health-gates, and auto-restores the previous symlink on failure.
5. Seed the first tenant only after health is green:

```bash
sudo -u leuwongrr-gateway env \
  API_KEY_PEPPER="$(sudo grep ^API_KEY_PEPPER= /opt/leuwongrr-gateway/config/gateway.env | cut -d= -f2-)" \
  DATABASE_PATH=/opt/leuwongrr-gateway/data/gateway.db \
  node /opt/leuwongrr-gateway/current/../ # use release path:
# Prefer:
sudo -u leuwongrr-gateway bash -lc '
  set -a; . /opt/leuwongrr-gateway/config/gateway.env; set +a
  cd /opt/leuwongrr-gateway/current
  node scripts/seed-tenant.mjs --tenant demo --name "Demo" --scopes models:read,chat:write
'
```

Note: `seed-tenant.mjs` is packaged only if present in the release tree. Prefer running it from the repo checkout with `DATABASE_PATH` pointed at the runtime DB, or copy the script into the release before seeding. Store the printed `api_key_once` offline; it is not recoverable.

6. Record SHA, changed canonical files, migration id, validation result, health, resource snapshot, and prior release SHA.

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
