# Operator release authority

This runbook is the canonical authorization gate when GitHub is a private source mirror without enforceable branch protection. Deployment mechanics remain in `docs/runbooks/operations.md`.

## Boundary

- **GitHub Free:** source mirror, commit history, pull-request discussion, optional CI evidence.
- **Operator workstation:** clean checkout, dependency install, validation, build, checksum, release evidence.
- **VPS:** runtime, data, secrets, backup, deploy, health, rollback. Never a development workstation.
- **Cloudflare:** public HTTPS, Tunnel, WAF, and Access boundary. Never a source or secret store.

## Workstation release gate

Use a fresh disposable clone for each production release, especially on Windows. This guarantees that `.gitattributes` applies LF endings before release-critical Linux files are tested. Run from the repository checkout on the operator workstation, never from `/home/ubuntu` or `/opt/leuwongrr-gateway/current`:

```bash
git fetch origin
git checkout <release-commit>
git status --short
npm ci --no-audit --no-fund
npm --prefix web ci --no-audit --no-fund
npm run ci:local
SHA=$(git rev-parse HEAD)
sha256sum -c ".release/$SHA.tar.gz.sha256"
git status --short
```

Acceptance:

- `git status --short` is empty before and after validation.
- `SHA` is a full 40-character commit present in the private mirror.
- Both lockfiles are present and `npm ci` is used; no floating install is accepted.
- `npm run ci:local` succeeds: conventions, secret scan, lint, typecheck, tests, backend and console build, shell syntax, immutable package, manifest verification.
- Release-critical shell scripts and systemd units contain LF only; the build normalizes its staged copy and verifies the finished artifact again.
- The artifact and checksum names exactly match the commit SHA.

Do not put `.env`, API keys, backup identities, cookies, provider credentials, or Cloudflare credentials in the checkout, artifact, GitHub, screenshots, or release evidence.

## Transfer boundary

From the operator workstation, not from inside the VPS:

```bash
SHA=$(git rev-parse HEAD)
scp ".release/$SHA.tar.gz" ".release/$SHA.tar.gz.sha256" \
  ubuntu@18.136.26.152:/tmp/
```

The VPS receives only the artifact and checksum. Do not copy the repository, `.git`, `node_modules`, local environment files, or private keys.

## Activation

First syntax-check the deploy entrypoint in the active release:

```bash
sudo bash -n /opt/leuwongrr-gateway/current/scripts/deploy.sh
```

When that succeeds, use the normal path:

```bash
sudo bash /opt/leuwongrr-gateway/current/scripts/deploy.sh \
  <full-git-sha> /tmp/<full-git-sha>.tar.gz
```

If the active entrypoint itself fails syntax validation, do not edit it on the host and do not retry an already-attempted SHA. Create and authorize a new merged SHA, then follow `docs/runbooks/artifact-deploy-bootstrap.md` to verify and execute the deploy entrypoint contained in that new immutable artifact.

Never retry a failed deployment with the same SHA after an invocation fails or an immutable release directory is created. Resolve the failure in source, create a new commit, rerun the workstation gate, and deploy the new SHA.

## Required evidence

Record only sanitized facts:

- release and previous full SHA;
- local validation command outcomes;
- artifact SHA-256;
- migration ID or `none`;
- `active-sha`, `ActiveState`, `NRestarts`, and `MemoryCurrent`;
- loopback listeners;
- liveness and token-protected readiness results;
- negative auth checks relevant to the release;
- backup age and latest verified restore evidence;
- rollback target.

Do not mark the release authorized if any item is missing. GitHub Actions green, by itself, is not production authorization.

## Source custody

Keep three copies:

1. operator working copy;
2. private GitHub mirror;
3. separate encrypted/offline source backup.

The production VPS is not a source backup. A release artifact is not a substitute for source history.
