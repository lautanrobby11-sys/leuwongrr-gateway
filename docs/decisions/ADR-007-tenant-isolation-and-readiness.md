# ADR-007: Tenant isolation, trusted client identity, and honest readiness

- Status: accepted
- Date: 2026-07-28
- Supersedes: none
- Related: ADR-001 (system boundaries), ADR-004 (deployment safety), ADR-005 (runtime envelope)

## Context

The gateway is only reachable through `router.leuwongrr.cloud` and
`api.leuwongrr.cloud`, both terminated by cloudflared on the same host. Three
properties assumed by the blueprint were not actually true in code:

1. Every request arrives from loopback, so the pre-auth source limiter keyed on
   `req.ip` behaved as a single global bucket. One caller could exhaust it for
   everybody.
2. `TenantStore.limits()` persisted `max_concurrent` and `rate_limit_rpm`, but
   only `daily_budget_units` was read at request time. Provisioned tenant limits
   were documentation, not enforcement.
3. `/health/ready` only ran `SELECT 1` against SQLite. Deploy verification and
   the rollback trigger in `scripts/deploy.sh` therefore reported success while
   OmniRoute was down, which is the exact failure a release must catch.

## Decision

- Client identity for the pre-auth limiter is resolved by `clientIdentity()`.
  The forwarded header is honoured only when `TRUST_PROXY=true` **and** the
  socket peer is loopback, and only after shape validation. Otherwise the socket
  address is used. Spoofing the header from outside the tunnel changes nothing.
- `TenantRateLimiterRegistry` and `TenantConcurrencyRegistry` own per-tenant
  fairness. Both are bounded by `TENANT_LIMIT_MAX_ENTRIES` and evict least
  recently used entries, because the process shares a 1.25 GiB envelope with
  OmniRoute. Concurrency acquisition returns `null` instead of throwing so the
  caller can release its budget reservation and answer a retryable
  `503 tenant_overloaded`.
- Per-tenant values come from `TenantStore.limits()` on each request and fall
  back to `RATE_LIMIT_RPM` / `TENANT_MAX_CONCURRENT`. A limit change takes effect
  without a restart.
- `/health/ready` probes the upstream router's unauthenticated health endpoint
  with `READY_UPSTREAM_TIMEOUT_MS` in addition to the database check, and cancels
  the probe body so the upstream permit is released. The path is configuration
  (`UPSTREAM_HEALTH_PATH`, default `/api/health`) because the upstream is no
  longer OmniRoute: 9Router serves `/api/health` and answers 401 on the
  OmniRoute-era `/api/monitoring/health`, which made a healthy host report
  `503 not_ready` after the 21 Aug 2026 migration.
- `TENANT_MAX_CONCURRENT` must not exceed `UPSTREAM_CONCURRENCY`; the invariant
  is enforced in `loadConfig`.

## Consequences

- Readiness is now a real dependency assertion, so a deploy against a broken
  OmniRoute fails and auto-restores the previous release instead of publishing a
  dead gateway.
- Operators must set `TRUST_PROXY=true` in `gateway.env` for per-caller limiting
  to apply; the default stays closed.
- Streaming responses hand their tenant slot to the stream lifecycle and release
  it on `end` or `error`, alongside budget settlement.
