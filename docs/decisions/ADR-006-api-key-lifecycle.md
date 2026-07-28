# ADR-006 — Single owner for API key lifecycle

- Status: accepted
- Date: 2026-07-28
- Supersedes: the standalone operator seed script

## Context

Credentials could be created through two unrelated code paths. The service used
the typed auth module, while the operator seed script carried its own copy of
the hashing and formatting rules and additionally created tables outside the
migration list. Two consequences followed:

- Any change to the key format or pepper handling had to be made twice. A miss
  would produce keys that look valid but fail authentication, with no signal
  until a tenant reported an outage.
- A database seeded by the script had tables that no migration had recorded, so
  later migrations could not rely on a known starting schema.

There was also no lifecycle beyond creation. Keys could not expire, could not be
rotated, and could only be revoked through manual SQL. On a multi-tenant
deployment that makes credential hygiene impossible to operate safely.

## Decision

All tenant provisioning goes through one store, `TenantStore`, used by the
service, the operator CLI, and the test harness.

- Key format, hashing, and scope validation stay in the auth module; the store
  is the only writer of `api_keys`.
- Schema changes belong to the migration list. The CLI opens the database
  through the gateway database class, so migrations always run first.
- Keys carry a name, mode, optional expiry, last-use timestamp, and rotation
  ancestry.
- Rotation issues a replacement inheriting name, scopes, and mode, and retires
  the previous key after an operator-chosen grace window. A future revocation
  timestamp means the key is still usable, which is what makes a zero-downtime
  rollover possible.
- Expired keys authenticate as unknown rather than as forbidden, so a probe
  cannot distinguish an expired credential from one that never existed.
- Revocation, listing, and rotation are scoped by tenant, so possession of a key
  id is not sufficient to affect another tenant.
- Per-tenant limits are stored alongside the tenant and clamped by the
  deployment-wide ceiling, so one tenant cannot consume the shared budget.

## Consequences

- `scripts/seed-tenant.mjs` is removed. Operators use `node dist/cli/keys.js`,
  which ships inside the release artifact and therefore always matches the
  running build.
- `last_used_at` is written at most once per minute per key to avoid adding a
  disk write to every authenticated request on a small VPS.
- Existing rows are migrated with defaults, so keys issued before this change
  keep working and are treated as live, non-expiring, and unnamed.
