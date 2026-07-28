# Operations runbook

## Preconditions

- Operator has VPS root and Cloudflare authority; no secret is pasted into Git/Notion/log.
- `/opt/leuwongrr-gateway/config/gateway.env` is root-owned mode 600.
- `leuwongrr-gateway` service user exists without login shell.
- Host tools `sqlite3`, `age` and `rsync` are installed. `scripts/vps-bootstrap.sh`
  installs them, but note the trap: the gateway embeds SQLite through
  `better-sqlite3` and never shells out to the `sqlite3` CLI, so a host missing
  these tools still runs the service perfectly and only fails when a backup is
  attempted.
- Baseline CPU/RSS/disk/FD/OmniRoute latency and SSH responsiveness are recorded before choosing final systemd limits.

## Developer / CI green path

1. Node 22 + `build-essential` + `python3` (native module `better-sqlite3`).
2. `npm install` then commit `package-lock.json` once so CI can use `npm ci`. The
   console has its own graph, so `web/package-lock.json` is committed too; the
   `lockfile` workflow opens a PR with both if either is missing.
3. `npm run validate` must pass locally (conventions, offline secret scan, lint, typecheck, tests).
4. Optional full local mirror of CI: `npm run ci:local` (builds backend + console and the immutable release tarball).
5. Push to the PR branch and wait for workflow `quality` to finish green on the same SHA.
6. Merge only when the PR check is green. Repository CI alone does **not** mean production is ready.

```bash
git checkout -b feat/my-change
cp .env.example .env   # fill secrets locally only; never commit
npm install
npm run validate && npm run ci:local
git push origin feat/my-change
```

## Dependency policy

Dependabot is limited to minor and patch updates for npm (root and `web/`) and
for GitHub Actions. Majors are excluded on purpose: a batch of unreviewed major
bumps once moved the repository to TypeScript 7, ESLint 10, Zod 4, Vitest 4 and
non-existent action tags such as `actions/checkout@v7`, which broke every run on
`main`. Pilot a major upgrade on its own branch, get a green `quality` run, and
only then merge.

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

1. Clean checkout on the exact git SHA: `git status --short`, `npm ci`, `npm run validate`.
2. Review diff and secret scan. Run `scripts/build-release.sh <40-char-sha>` from that commit.
   - Emits `.release/<sha>.tar.gz` + `.release/<sha>.tar.gz.sha256`
   - Package contents: `dist/` (including `dist/public` and `dist/cli/keys.js`),
     `package.json`, `web/package.json`, both lockfiles when present,
     `scripts/{deploy,rollback,backup,restore-drill}.sh`,
     `infra/systemd/leuwongrr-gateway.service`,
     `infra/systemd/leuwongrr-gateway-snapshot.service`,
     `infra/systemd/leuwongrr-gateway-snapshot.timer`, `RELEASE`,
     `manifest.sha256`
   - The script refuses to package unless
     `dist/public/{admin,member,chat,login}.html` and `dist/public/assets` exist,
     and unless every unit above is present in the repository.
3. Transfer only the artifact and checksum, then run `sudo scripts/deploy.sh <40-char-sha> <artifact.tar.gz>`.
4. Deploy verifies checksum + manifest, requires `package-lock.json` and the four
   console entries, installs production dependencies on the server, runs preflight
   as the service user with the release directory as the working directory,
   atomically swaps `current`, syncs the systemd unit from the release,
   health-gates, and auto-restores the previous symlink on failure.
5. Issue the first operator key only after health is green. The CLI ships inside
   the release so hashing rules always match the running service:

```bash
sudo -u leuwongrr-gateway bash -lc '
  set -a; . /opt/leuwongrr-gateway/config/gateway.env; set +a
  cd /opt/leuwongrr-gateway/current
  node dist/cli/keys.js issue --tenant demo --scopes models:read,chat:write
'
```

Store the printed key offline; only its peppered HMAC-SHA256 hash is persisted
and the plaintext is not recoverable. `node dist/cli/keys.js list` and
`... revoke <id>` cover the rest of the lifecycle.

6. Record SHA, changed canonical files, migration id, validation result, health, resource snapshot, and prior release SHA.

## Post-deploy negative checks

- `ss -ltnp`: Gateway only `127.0.0.1:2080`; OmniRoute only expected loopback port.
- Unknown route returns 404 and produces no OmniRoute request.
- `/v1/models` without/invalid key returns 401; wrong scope returns 403.
- `/health/ready` without internal token returns 404.
- `/admin*`: missing/forged/expired Access JWT fails; valid Access identity without application role fails.
- `/member` and `/chat` without a session cookie redirect to `/login`; a member
  session cannot read another account's usage, wallet or payments.
- `/admin`, `/member`, `/chat`, `/login` all return HTML, not `503 console_not_built`.
- A request from an unfunded account returns 402 rather than reaching OmniRoute.
- A replayed Cryptomus webhook credits the wallet exactly once.
- `/v1` and `/v1beta` never redirect to Cloudflare interactive login.
- Check `systemctl show leuwongrr-gateway` resource limits and `journalctl` redaction.

## Backup/restore

`scripts/backup.sh` refuses to run without `AGE_RECIPIENT`, because the archive
contains the whole tenant database and every API key hash; an unencrypted copy
on disk is not an acceptable fallback. Generate the operator keypair once:

```bash
umask 077
age-keygen -o ~/leuwongrr-backup-identity.txt
sed -n 's/^# public key: //p' ~/leuwongrr-backup-identity.txt
```

Take a backup and verify it in a temporary directory:

```bash
RECIPIENT=$(sed -n 's/^# public key: //p' ~/leuwongrr-backup-identity.txt)
sudo AGE_RECIPIENT="$RECIPIENT" bash scripts/backup.sh
# data/backups is not readable by the login user, so expand the glob as root
BACKUP=$(sudo bash -c 'ls -1 /opt/leuwongrr-gateway/data/backups/*.tar.gz.age | tail -n1')
sudo bash scripts/restore-drill.sh "$BACKUP" ~/leuwongrr-backup-identity.txt
```

The drill validates the archive checksum, the inner manifest, `PRAGMA
integrity_check`, `PRAGMA foreign_key_check`, and the presence of the core
tables, then prints `restore drill passed`. Backups use the SQLite online backup
API; never copy a live WAL database directly.

Key custody is a deliberate decision, not a detail. While the identity file sits
on the same host as `data/backups`, encryption protects nothing against an
attacker who owns the host — key and ciphertext are in one place. Move the
identity off the server and keep at least two copies elsewhere. There is no
recovery path: lose the identity and every backup is permanently unreadable. The
public recipient is not secret and may be stored on the host for scheduled runs.

If the identity is ever exposed — pasted into a chat, a ticket, a screenshot —
treat every existing archive as compromised: generate a new keypair, take a
fresh snapshot, and delete the archives written for the old recipient. They
cannot be re-encrypted.

## Scheduled snapshots

A snapshot that runs only when someone remembers is not a backup. Install the
timer once the first manual drill has passed, and only from a release that
actually contains the units — they ship inside the artifact, so the files exist
under `current/infra/systemd` only after a deploy of that release:

```bash
# the public recipient is not a secret; the identity file stays off the host.
# Substitute the real age1... value; a literal placeholder makes every
# scheduled run fail inside age with an unusable recipient.
sudo sh -c 'printf "AGE_RECIPIENT=%s\n" age1realrecipientvalue >> /opt/leuwongrr-gateway/config/gateway.env'
sudo install -m 0644 \
  /opt/leuwongrr-gateway/current/infra/systemd/leuwongrr-gateway-snapshot.service \
  /opt/leuwongrr-gateway/current/infra/systemd/leuwongrr-gateway-snapshot.timer \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now leuwongrr-gateway-snapshot.timer
sudo systemctl start leuwongrr-gateway-snapshot.service   # prove it works now
sudo systemctl list-timers leuwongrr-gateway-snapshot.timer
```

The timer fires at 19:15 UTC (02:15 Asia/Jakarta) with up to ten minutes of
jitter and `Persistent=true`, so a host that was off at the scheduled time takes
one snapshot on the next boot instead of silently skipping a day.

Retention is by count, not age: `backup.sh` keeps the newest `BACKUP_KEEP`
archives (default 14) and prunes only after the new archive and its checksum
exist, so a failed run cannot delete the last good copy. Counting rather than
expiring by date means a host that stops taking snapshots keeps the old ones
rather than ending up with none. Override by adding `BACKUP_KEEP=<n>` to
`gateway.env`.

The unit is separate from `leuwongrr-gateway.service` on purpose: the gateway
sandbox forbids the filesystem writes a snapshot needs, and a snapshot failure
must never stop the service. Check results with
`systemctl status leuwongrr-gateway-snapshot.service` and
`journalctl -u leuwongrr-gateway-snapshot.service`.

The timer proves snapshots are taken, not that they are restorable. Repeat the
restore drill after any schema migration and once real tenant data exists.

## Rollback

`sudo scripts/rollback.sh <previous-40-char-sha>`. It preflights the target,
atomically moves `current`, restarts, and requires readiness; an unhealthy
rollback target restores the original symlink. Forward-only migrations use
expand/migrate/contract; do not invent down migrations.

## Status discipline

Do not mark production DONE until Cloudflare, tenant isolation, load/overload, backup restore, and rollback have real captured outputs. Repository CI alone proves only repository gates.
