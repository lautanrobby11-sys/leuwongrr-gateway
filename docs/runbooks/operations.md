# Operations runbook

## Preconditions

- Operator has VPS root and Cloudflare authority; no secret is pasted into Git/Notion/log.
- `/opt/leuwongrr-gateway/config/gateway.env` is root-owned mode 600 and is **not**
  readable by the service user. Any documented command that reads it as
  `leuwongrr-gateway` is impossible on this host; read it as root and drop
  privileges afterwards.
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

No checkout is ever copied to the VPS. `scripts/vps-bootstrap.sh` ships inside the
release artifact and is extracted from it with manifest verification. The full
procedure, including the checksum and carriage-return proofs, is
`docs/runbooks/artifact-deploy-bootstrap.md` under "First deploy on a bare host".

Summary of what it does: creates `/opt/leuwongrr-gateway` and its tree, the
`leuwongrr-gateway` service user, a mode-600 `config/gateway.env` seeded with every
key the schema requires (secrets as the literal `REPLACE_ME`), and installs the
systemd unit without starting it. Substitute the placeholders in place before any
deploy; generate values with `openssl rand -hex 32` and never paste them into
chat, Git, or Notion.

## Validate and release

1. Clean checkout on the exact git SHA: `git status --short`, `npm ci`, `npm run validate`.
2. Review diff and secret scan. Run `scripts/build-release.sh <40-char-sha>` from that commit.
   - Emits `.release/<sha>.tar.gz` + `.release/<sha>.tar.gz.sha256`
   - Package contents: `dist/` (including `dist/public` and `dist/cli/keys.js`),
     `package.json`, `web/package.json`, both lockfiles when present,
     `scripts/{deploy,rollback,backup,restore-drill}.sh`,
     `scripts/ping-snapshot-healthcheck.sh`, `scripts/vps-bootstrap.sh`,
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
   the release so hashing rules always match the running service.

   `gateway.env` is `root:root` mode 600 and unreadable by the service user, so
   the environment is sourced as root and the process then drops to the service
   user with `runuser`. Running the CLI as root would leave `gateway.db-wal` and
   `gateway.db-shm` owned by root; passing secrets as `env VAR=...` or `sudo -E`
   would expose them in `ps`.

```bash
sudo bash -c 'set -a; . /opt/leuwongrr-gateway/config/gateway.env; set +a
  cd /opt/leuwongrr-gateway/current
  runuser -u leuwongrr-gateway -- /usr/bin/node dist/cli/keys.js \
    key:issue --tenant <tenant> --scopes models:read,chat:write'
```

Store the printed key offline; only its peppered HMAC-SHA256 hash is persisted
and the plaintext is not recoverable.

The command names are namespaced. `keys.js issue`, `keys.js list` and
`keys.js revoke` do not exist and exit non-zero. The real contract in
`src/cli/keys.ts` is:

```text
tenant:create   --tenant <id> [--name <label>] [--model <id>]
key:issue       --tenant <id> [--name <label>] [--scopes a,b] [--mode live|test] [--expires-days N]
key:list        --tenant <id>
key:revoke      --tenant <id> --key <key-id>
key:rotate      --tenant <id> --key <key-id> [--grace-minutes N] [--expires-days N]
limits:set      --tenant <id> --daily-units N --max-concurrent N --rpm N
model:enable    --tenant <id> --model <id>
model:disable   --tenant <id> --model <id>
account:role    --email <address> --role member|support|operator|admin|owner
plan:upsert     --plan <id> --name <label> --price-cents N --included-tokens N \
                --overage-cents N --max-concurrent N --rpm N --daily-units N \
                [--models a,b] [--inactive]
```

`account:role` is the only way an account becomes `admin`. The console's
`requireAdmin` accepts `admin` and `owner` only, and no migration or sign-in path
ever assigns either, so without this command the admin surface is unreachable.
The account must have signed in once first — the command promotes an existing row
and fails on an unknown email rather than creating one. Granting the role does
**not** grant access on its own: `/admin*` still requires a verified Cloudflare
Access assertion. The promotion is recorded as an `operator.account.role` row in
`audit_logs` with `actor_type='system'` and the previous role in its metadata, so
a privilege change made outside every HTTP surface is still discoverable:

```bash
sudo -u leuwongrr-gateway sqlite3 -readonly /opt/leuwongrr-gateway/data/gateway.db \
  "SELECT created_at, metadata_json FROM audit_logs WHERE event='operator.account.role' ORDER BY created_at DESC LIMIT 5;"
```

`plan:upsert` seeds the plan catalogue that `/console/api/member/plans` reads. An
empty catalogue leaves the member console with nothing to subscribe to.
`--models` is validated against the registry's public model IDs and defaults to
`lwrr-text`. Prices, token allowances and daily units accept `0`. Every field is
checked against `src/billing/plan-input.ts`, the same schema
`POST /console/api/admin/plans` uses, so `--max-concurrent` is capped at 64 and
`--rpm` at 100000: `applyPlanLimits` copies plan values into `tenant_limits`, so
an out-of-range plan would become live enforcement state rather than a merely odd
row. A rejected value prints `invalid plan: <field>: <reason>` and writes nothing.

Before any release that carries migration `0010` (model groups), the model
catalog and every **active** plan membership must already exist in the database.
The backfill in `src/persistence/migrations.ts::runModelGroupBackfill` validates
all plan memberships and policy references before it writes, and it fails closed:
an active plan whose `models_json` is empty (or whose membership is a strict
subset/unknown set of the catalog) aborts the migration with
`legacy_membership_ambiguous` and a preflight refusal. The legacy
`lwrr-text` fallback row is only seeded when the catalog is empty **and** no
active plan blocks the validation step, so an existing active plan without
membership cannot be "repaired" by the migration itself.

Observed 15 August 2026: deploy of production candidate `ed2279a` was refused in
application preflight for exactly this reason on a host whose `models` table was
empty while plan `starter` was active with `models_json='[]'`. The SHA was
abandoned (never retried after side effects), the catalog was seeded through the
admin console (`Models -> New model`, then plan edit adding the model to
`starter`), and the next SHA deployed cleanly. Seed the catalog through the
console or `plan:upsert` **before** running such a deploy:

```bash
# via the admin console: Models -> New model (e.g. id lwrr-text,
# upstream_model auto, provider other, zero prices, capabilities text/stream)
# then Plans -> starter -> add the model to its membership.
# Mirror through the CLI after the fact (non-destructive re-upsert):
node dist/cli/keys.js plan:upsert --plan starter --name 'Starter' \
  --price-cents 0 --included-tokens 1000000 --overage-cents 7 \
  --max-concurrent 2 --rpm 60 --daily-units 100000 --models lwrr-text
```

There is no `tenant:list`. To inventory tenants, read the database read-only
instead of inventing a subcommand.

`limits:set` validates `--daily-units`, `--max-concurrent` and `--rpm` as
positive integers, so `--daily-units 0` is rejected even though the underlying
store accepts `0`. Quarantine a tenant with `model:disable` plus revocation of
its keys rather than expecting a zero budget.

After any CLI run, confirm ownership stayed correct:

```bash
sudo ls -l /opt/leuwongrr-gateway/data/gateway.db*
```

All three of `gateway.db`, `gateway.db-wal` and `gateway.db-shm` must remain
`leuwongrr-gateway:leuwongrr-gateway` mode 600.

6. Record SHA, changed canonical files, migration id, validation result, health, resource snapshot, and prior release SHA.

## Post-deploy negative checks

- `ss -ltnp`: Gateway only `127.0.0.1:2080`; OmniRoute only expected loopback port.
- Unknown route returns 404 and produces no OmniRoute request. The body is the
  gateway envelope `{"error":{"code":"route_not_found",...}}` with
  `x-request-id`, `cache-control: no-store` and `nosniff`, on both an unlisted
  path and a console path while `CONSOLE_ENABLED=false`. Fastify's own
  `{"message":"Route GET:/ not found",...}` must never appear; if it does, a route
  is allowlisted without a handler.
- `/v1/models` without/invalid key returns 401; wrong scope returns 403.
- A **revoked** key returns `403 insufficient_scope`, not `401`. `authenticate()`
  filters only `expires_at`, so a revoked key still resolves and `requireScope()`
  rejects it. `401 invalid_api_key` covers unknown, malformed and expired keys.
  Demanding `401` after revocation would require a source change.
- `/health/ready` without internal token returns 404.
- `/health/ready` proves the upstream health route answers, not that `/v1/*` is
  usable: OmniRoute leaves its health route unauthenticated while `/v1/*`
  requires a credential. Readiness can be green while chat is impossible.
- `/admin*`: missing/forged/expired Access JWT fails; valid Access identity without application role fails.
- `/member` and `/chat` without a session cookie redirect to `/login`; a member
  session cannot read another account's usage, wallet or payments.
- `/admin`, `/member`, `/chat`, `/login` all return HTML, not `503 console_not_built`.
  The apex `/` serves the sign-in portal and must also return HTML, not 404.
- `402 budget_exceeded` is reachable by exhausting the tenant budget. The
  unfunded-account `402` is **not** provable while `CONSOLE_ENABLED=false`,
  because `assertFunded()` exits early; do not record it as evidence.
- A replayed Cryptomus webhook credits the wallet exactly once.
- `/v1` and `/v1beta` never redirect to Cloudflare interactive login.
- Check `systemctl show leuwongrr-gateway` resource limits and `journalctl` redaction.

The edge configuration these cases exercise — tunnel target, the `/admin*`-only
Access application, and the cache-bypass list — is recorded in
`infra/cloudflare/README.md`. Dashboard changes are operator-owned and belong in
the deployment audit; that file is the canonical record, not this runbook.

## Upstream credential

OmniRoute runs with `REQUIRE_API_KEY=true`, so every `/v1/*` upstream call needs
`Authorization: Bearer <key>`. Without `OMNIROUTE_API_KEY` the gateway fails
closed: production refuses to boot, and a misconfigured runtime could only answer
`502 upstream_error` on chat while `/v1/models` still succeeded.

Issue the key from the OmniRoute dashboard and add it to `gateway.env` as root,
keeping the file `root:root` mode 600. The value never belongs in chat, Notion,
logs, `argv`, or a release artifact. Only its presence is logged, as
`upstreamCredential` in the `gateway_listening` record.

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
attacker who owns the host - key and ciphertext are in one place. Move the
identity off the server and keep at least two copies elsewhere, verify a restore
from an off-host copy, and only then delete the on-host identity. There is no
recovery path: lose the identity and every backup is permanently unreadable. The
public recipient is not secret and may be stored on the host for scheduled runs.

If the identity is ever exposed - pasted into a chat, a ticket, a screenshot -
treat every existing archive as compromised: generate a new keypair, take a
fresh snapshot, and delete the archives written for the old recipient. They
cannot be re-encrypted.

## Scheduled snapshots

A snapshot that runs only when someone remembers is not a backup. Install the
timer once the first manual drill has passed, and only from a release that
actually contains the units - they ship inside the artifact, so the files exist
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
restore drill after any schema migration and once real tenant data exists. A
missed-ping alert is only proven after waiting out the monitor's real grace
period and confirming the alert arrived.

## Rollback

`sudo scripts/rollback.sh <previous-40-char-sha>`. It preflights the target,
atomically moves `current`, restarts, and requires readiness; an unhealthy
rollback target restores the original symlink. Forward-only migrations use
expand/migrate/contract; do not invent down migrations.

## Status discipline

Do not mark production DONE until Cloudflare, tenant isolation, load/overload, backup restore, and rollback have real captured outputs. Repository CI alone proves only repository gates.
