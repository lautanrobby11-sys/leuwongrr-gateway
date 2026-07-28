# Contributing

## Non-negotiable rules

Read `AGENTS.md` first. Work in the canonical module, never in a copy, and never with a forbidden filename suffix.

## Workflow

1. Branch from `main` using `feat/`, `fix/`, `ops/`, or `docs/` plus a short scope.
2. Search with `rg` before adding a route, config key, schema column, or helper.
3. Add or update tests for behaviour you change.
4. Run `npm run validate` locally; it executes convention checks, the offline secret scan, lint, typecheck, and tests.
5. Run `npm run ci:local` from a clean operator-workstation checkout before a release candidate is authorized.
6. Open a pull request using the template and fill in the evidence table with real results. GitHub is a source mirror and review surface; an unenforced branch setting is never release evidence.

## Commit style

Use `type(scope): imperative summary`, for example `fix(auth): reject revoked keys`. Keep one logical change per commit.

## Database changes

Add a new forward-only migration in `src/persistence/migrations.ts`. Never edit a released migration. Use expand, migrate, then contract across separate releases.

## Release

`scripts/build-release.sh <git-sha>` builds an immutable artifact with a manifest and checksum. Authorization when branch protection is unavailable is defined by `docs/adr/ADR-012-local-release-authority.md` and `docs/runbooks/operator-release-authority.md`. Deployment, rollback, backup, and restore procedures remain in `docs/runbooks/operations.md`.

Build and validation happen on the operator workstation. The VPS receives only the artifact and checksum; it never receives GitHub credentials, runs `git pull`, or serves as a source-editing environment. Do not mark work done until the required drills produce captured evidence.