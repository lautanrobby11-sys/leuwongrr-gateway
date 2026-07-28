# LeuwongRR Gateway

A single-tenant-per-key API gateway that puts an OpenAI, Anthropic and Responses
compatible surface in front of a private OmniRoute instance, plus a lightweight
web console for administration, member self-service and chat.

```
client  ->  router.leuwongrr.cloud  ->  api.leuwongrr.cloud  ->  /v1/*  ->  gateway (127.0.0.1:2080)  ->  OmniRoute (127.0.0.1:20128)
```

The process never listens on a public interface. Cloudflare terminates TLS and a
Cloudflare Tunnel carries traffic to loopback, which is why `scripts/deploy.sh`
refuses to activate a release whose `GATEWAY_HOST` is not `127.0.0.1`.

## What ships in a release

| Surface | Path | Auth |
| --- | --- | --- |
| Liveness | `GET /health/live` | none |
| Readiness | `GET /health/ready` | `x-internal-ready-token` |
| Models | `GET /v1/models` | API key, scope `models:read` |
| Chat Completions | `POST /v1/chat/completions` | API key, scope `chat:write` |
| Responses | `POST /v1/responses` | API key, scope `responses:write` |
| Messages | `POST /v1/messages` | API key, scope `messages:write` |
| Token count | `POST /v1/messages/count_tokens` | API key, scope `messages:write` |
| Admin console | `GET /admin` | Cloudflare Access JWT **and** app role |
| Member console | `GET /member` | session cookie |
| Chat console | `GET /chat` | session cookie |
| Login | `GET /login` | none |
| Cryptomus webhook | `POST /webhooks/cryptomus` | MD5 request signature |

Every route is declared in `src/policy/allowlist.ts`. There is no catch-all
passthrough: an undeclared path is a 404 by construction.

## Local development

```bash
npm install
npm run validate      # conventions, secret scan, lint, typecheck, unit tests
npm run build:all     # backend (tsc) + console (vite -> dist/public)
npm run dev           # watch mode on 127.0.0.1:2080
```

`npm run ci:local` reproduces the CI pipeline end to end, including packaging a
release tarball from the current HEAD.

## Deploying to the VPS

Everything below runs on Ubuntu 24.04. The gateway lives under
`/opt/leuwongrr-gateway` with immutable, per-SHA release directories and an
atomic `current` symlink.

```
/opt/leuwongrr-gateway
├── config/gateway.env        root:root 0600, never inside a release
├── releases/<sha>/           immutable, one directory per deploy
├── current -> releases/<sha> atomic symlink swapped on activation
├── data/                     SQLite database, attachments, backups
├── logs/
└── runtime/active-sha
```

### 1. Bootstrap the host (once)

```bash
sudo bash scripts/vps-bootstrap.sh
```

Creates the `leuwongrr-gateway` system user, the directory tree, a seeded
`config/gateway.env` with mode 600, and installs plus enables the systemd unit.

### 2. Fill in the environment

```bash
sudo install -m 600 -o root -g root /dev/null /opt/leuwongrr-gateway/config/gateway.env
sudo openssl rand -hex 32   # API_KEY_PEPPER
sudo openssl rand -hex 32   # INTERNAL_READY_TOKEN
sudo nano /opt/leuwongrr-gateway/config/gateway.env
```

Use `.env.example` as the source of truth for keys and cross-field rules.
Deployment aborts if the file is not `root:root` mode `600`.

### 3. Build the artifact (on a workstation or in CI)

```bash
git checkout main && git pull
bash scripts/build-release.sh "$(git rev-parse HEAD)"
# -> .release/<sha>.tar.gz and .release/<sha>.tar.gz.sha256
```

The tracked working tree must be clean. The script builds the backend **and**
the console, verifies that `dist/public/{admin,member,chat,login}.html` and
`dist/public/assets` exist, and records a `manifest.sha256` over every staged
file. A release that cannot serve the dashboards is never produced.

CI attaches the same tarball to every green `quality` run, so you can download
the artifact instead of building locally.

### 4. Transfer and deploy

```bash
SHA=$(git rev-parse HEAD)
scp ".release/$SHA.tar.gz" ".release/$SHA.tar.gz.sha256" ubuntu@18.136.26.152:/tmp/
ssh ubuntu@18.136.26.152 "sudo bash /opt/leuwongrr-gateway/current/scripts/deploy.sh $SHA /tmp/$SHA.tar.gz"
```

For the very first deploy there is no `current/scripts`, so extract the tarball
once and call `deploy.sh` from the extracted copy.

`deploy.sh` verifies the checksum and manifest, requires `package-lock.json`,
requires the four console entries, runs `npm ci --omit=dev`, runs preflight as
the service user with the release directory as the working directory, swaps the
symlink, restarts the unit and gates on both health probes. If readiness does
not come back within 30 seconds it restores the previous release automatically.

### 5. Verify

```bash
curl -fsS http://127.0.0.1:2080/health/live
curl -fsS -H "x-internal-ready-token: $INTERNAL_READY_TOKEN" http://127.0.0.1:2080/health/ready
cat /opt/leuwongrr-gateway/runtime/active-sha
systemctl status leuwongrr-gateway --no-pager
journalctl -u leuwongrr-gateway -n 50 --no-pager
```

From the outside: `https://api.leuwongrr.cloud/v1/models` with a live key, and
`https://api.leuwongrr.cloud/login` in a browser.

### 6. Roll back

```bash
sudo bash /opt/leuwongrr-gateway/current/scripts/rollback.sh <previous-sha>
```

The target must already exist under `releases/`. Rollback preflights the target
first and reverts itself if the older release fails to become ready.

## Operator tasks

### Issue an API key

```bash
sudo -u leuwongrr-gateway env $(sudo cat /opt/leuwongrr-gateway/config/gateway.env | xargs) \
  node /opt/leuwongrr-gateway/current/dist/cli/keys.js issue --tenant <tenant> --scopes chat:write,models:read
```

The plaintext key is printed once and only its HMAC-SHA256 hash (peppered with
`API_KEY_PEPPER`) is stored. Keys look like `lwrr_live_…` or `lwrr_test_…`.
Subcommands cover `list`, `revoke` and rotation.

### Backups and restore drill

```bash
sudo bash /opt/leuwongrr-gateway/current/scripts/backup.sh          # age-encrypted snapshot
sudo bash /opt/leuwongrr-gateway/current/scripts/restore-drill.sh <backup> <identity>
```

Run the drill at least once per quarter; an unverified backup is not a backup.

## Cloudflare configuration

1. DNS: `api.leuwongrr.cloud` and `router.leuwongrr.cloud` proxied through
   Cloudflare, both served by the existing `cloudflared` tunnel to
   `http://127.0.0.1:2080`.
2. Access: create a **self-hosted** application covering `api.leuwongrr.cloud/admin*`
   only. Do not cover `/v1/*`, `/member`, `/chat` or the webhook — API clients
   and members do not carry Access cookies.
3. Copy the team domain and the Application Audience tag into
   `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`.
4. Keep `TRUST_PROXY=true` so the real client IP is read from `cf-connecting-ip`
   for rate limiting and audit records.

Access is the outer gate; the application still checks that the authenticated
identity holds the `owner` or `admin` role. Both must pass.

## Using the gateway from a client

Any OpenAI-compatible client works by pointing the base URL at the gateway:

```bash
curl https://api.leuwongrr.cloud/v1/chat/completions \
  -H "authorization: Bearer $LWRR_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"lwrr-text","messages":[{"role":"user","content":"ping"}]}'
```

Anthropic-style clients use `POST /v1/messages` with the same bearer token.
Streaming is server-sent events on all three protocols.

## Repository conventions

- Routes must be registered in `src/policy/allowlist.ts`; no wildcard proxying.
- Migrations are forward-only and live in `src/persistence/migrations`.
- Filenames may not carry `-new`, `-final`, `-fix`, `-backup`, `-old`, `-temp`
  and similar suffixes; `npm run check:conventions` enforces this.
- Prompts and completions are never logged; see `src/observability.ts`.
- Dependabot is restricted to minor and patch updates. Major upgrades change the
  toolchain and must be piloted on a branch with a green `quality` run.

Architecture decisions live in `docs/decisions/` (ADR-001 to ADR-008) and
`docs/adr/ADR-009-console-accounts-and-billing.md`. Operational procedures live
in `docs/runbooks/operations.md`.
