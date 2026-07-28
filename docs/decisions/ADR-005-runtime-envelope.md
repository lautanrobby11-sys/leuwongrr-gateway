# ADR-005: Lightweight and stable runtime envelope

- Status: Accepted
- Date: 2026-07-28

## Context

The production host is a 2 vCPU / 1.9 GiB VPS that already runs OmniRoute and must stay responsive over SSH. The gateway previously had no request rate limiting, no idle timeout for streaming responses, an unbounded SQLite page cache, and no retention for `usage_events`, `audit_logs`, or `idempotency_keys`. Each of these is a slow-burn availability risk rather than a functional bug.

## Decision

1. Two memory-bounded token bucket limiters: one keyed by request source before authentication, one keyed by credential hash after authentication. Both evict idle entries and enforce a hard entry ceiling.
2. Health endpoints are never rate limited so monitoring and deploy gating stay reliable under load.
3. Streaming responses enforce an idle timeout that aborts the upstream call, releases the concurrency permit, and reconciles the budget reservation.
4. SQLite runs with `synchronous = NORMAL`, a bounded page cache, `mmap_size = 0`, and `wal_autocheckpoint = 512` so memory and WAL growth stay predictable.
5. A periodic maintenance pass deletes expired idempotency claims, settled or released usage events older than the retention window, and aged audit rows, then truncates the WAL.
6. The service runs with a 192 MiB V8 heap ceiling inside a 384 MiB cgroup limit so the process fails predictably instead of forcing the host into swap.
7. Default upstream concurrency is 4, matched to the measured host rather than an optimistic default.

## Consequences

Sustained abusive traffic receives `429` with a retry hint instead of degrading the host. Storage growth is bounded without manual intervention. Retention removes historical usage detail after the configured window, so any long-term reporting must be exported before expiry. These limits are configuration values and should be re-tuned only against captured VPS measurements.
