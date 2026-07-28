# Contributing

## Non-negotiable rules

Read `AGENTS.md` first. Work in the canonical module, never in a copy, and never with a forbidden filename suffix.

## Workflow

1. Branch from `main` using `feat/`, `fix/`, `ops/`, or `docs/` plus a short scope.
2. Search with `rg` before adding a route, config key, schema column, or helper.
3. Add or update tests for behaviour you change.
4. Run `npm run validate` locally; it executes convention checks, the offline secret scan, lint, typecheck, and tests.
5. Run `npm run build` before packaging a release.
6. Open a pull request using the template and fill in the evidence table with real results.

## Commit style

Use `type(scope): imperative summary`, for example `fix(auth): reject revoked keys`. Keep one logical change per commit.

## Database changes

Add a new forward-only migration in `src/persistence/migrations.ts`. Never edit a released migration. Use expand, migrate, then contract across separate releases.

## Release

`scripts/build-release.sh <git-sha>` builds an immutable artifact with a manifest and checksum. Deployment, rollback, backup, and restore procedures are in `docs/runbooks/operations.md`. Do not mark work done until the required drills produce captured evidence.
