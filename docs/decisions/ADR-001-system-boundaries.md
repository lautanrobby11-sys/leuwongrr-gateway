# ADR-001: Gateway–OmniRoute boundary

- Status: Accepted
- Date: 2026-07-28

## Decision
Gateway owns identity, tenant authorization, API keys/scopes, capability policy, quota/budget, public contracts, idempotency, metering, and audit. OmniRoute owns provider credentials, adapter translation, routing, fallback, cooldown, and provider health.

Communication is HTTP from Gateway to `http://127.0.0.1:20128`. Gateway binds `127.0.0.1:2080`. No shared files, databases, env, containers, or secrets. Public routes use an explicit method/path allowlist; there is no generic proxy.

## Consequences
A capability mismatch is rejected before upstream cost. Deployment, data, service account, logs, backup, and lifecycle remain independent. Public OmniRoute administration is not exposed by this project.