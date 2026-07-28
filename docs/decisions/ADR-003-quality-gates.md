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
