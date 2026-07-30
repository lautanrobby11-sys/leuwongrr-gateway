# ADR-003: Quality gates and release packaging

## Status

Accepted

## Context

The gateway must stay reviewable and deployable without GitHub Advanced Security, without a paid secret scanner, and before a lockfile exists. Early CI failures came from lockfile caching, forbidden filename tokens on the canonical backup script, external action friction, and overly brittle TypeScript/test casts.

## Decision

1. One workflow job `quality / validate` with named steps so the first failure is attributable from the Actions UI alone.
2. Offline secret scan via `scripts/scan-secrets.mjs` instead of external gitleaks action.
3. Native toolchain installed on the runner for `better-sqlite3`.
4. `npm ci` when `package-lock.json` exists; otherwise `npm install --no-package-lock` so CI does not dirty the tree with an untracked lockfile.
5. Artifact upload only on success; workflow permissions grant `actions: write` for artifacts and keep `contents: read`.
6. Release tarball contains `dist`, `package.json`, optional lockfile, `RELEASE`, and `manifest.sha256`. No SBOM step until a committed lockfile makes `npm sbom` deterministic.
7. TypeScript keeps `strict` but drops `exactOptionalPropertyTypes` and `vitest/globals` type injection; tests import from `vitest` explicitly.
8. Vitest runs in `forks` with `fileParallelism: false` to avoid native-module races.

## Consequences

- Operators must commit `package-lock.json` for fully deterministic installs.
- Secret scanning coverage is pattern-based, not entropy-based; CodeQL/Advanced Security remain optional upgrades.
- Production readiness still requires VPS drills outside CI.

## Update 2026-07-30

- Decision 6 is superseded on contents: the tarball also stages
  `scripts/{deploy,rollback,backup,restore-drill,ping-snapshot-healthcheck,vps-bootstrap}.sh`,
  the three systemd units, `web/package.json`, and both lockfiles when present.
  `vps-bootstrap.sh` ships even though it runs before the first deploy, because
  copying the repository to the VPS is forbidden and the artifact is therefore the
  only path by which the documented host-prep script can reach the host. Both
  lockfiles are now committed, so the "optional lockfile" wording describes the
  script's tolerance, not the current state.
- The gate set the workflow treats as required is eleven named steps —
  `conventions`, `secrets`, `lint`, `typecheck`, `tests`, `build`, `console`,
  `shell`, `package`, `checksum`, `clean` — and `.github/pull_request_template.md`
  now enumerates them so PR evidence cannot silently omit one. Green Actions is
  not production authorization; the workstation `npm run ci:local` result is
  recorded separately.
- `npm run lint` now covers `web/src`, `eslint.config.js` and `vitest.config.ts`,
  and `scripts/check-conventions.mjs` skips the same directories as the secret
  scanner. Before that, generated output under `dist/` and `.release/` could fail
  the filename gate on files no human wrote.
- The `keys` and `keys:dev` npm scripts were removed. The operator CLI must run
  with the same pepper as the running service, and a wrapper script hid whether
  it was executing the compiled release or the local source.
