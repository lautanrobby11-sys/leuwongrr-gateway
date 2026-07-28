# ADR-004: Fail-closed production deployment

- Status: Accepted
- Date: 2026-07-28

## Context

The verified VPS has 2 vCPU, 1.9 GiB RAM, 8 GiB swap, and OmniRoute bound to `127.0.0.1:20128`. Gateway must not consume the capacity needed by OmniRoute or SSH. The initial deploy path allowed a production install without a lockfile, checked only liveness, and could leave a failed first-release symlink active.

## Decision

- Production deploy requires `package-lock.json` and uses `npm ci --omit=dev`; there is no non-deterministic fallback.
- Artifact checksum and internal manifest are verified before dependency installation.
- Runtime configuration must be root-owned mode 600 and the canonical origin must be `127.0.0.1:2080`.
- Preflight runs as the non-root service identity before activation.
- Activation succeeds only when both public liveness and token-protected readiness pass within 30 seconds.
- Failed upgrades restore the previous symlink. Failed first deploys remove `current` and stop the service.
- A failed, inactive release directory is removed so the same immutable SHA can be rebuilt and retried only after fixing the deployment inputs.
- The initial resource envelope is `MemoryHigh=256M`, `MemoryMax=384M`, `TasksMax=96`, and upstream concurrency 4. These values may change only after captured VPS measurements.

## Consequences

Deployment remains blocked until a committed lockfile exists. Repository CI success does not authorize production activation; backup restore, rollback, tenant-isolation, overload, Cloudflare boundary, and resource evidence are still required.
