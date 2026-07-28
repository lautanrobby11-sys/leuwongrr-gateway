# Production-readiness audit — 2026-07-28

Baseline: `main@cb5ca622564f561aca781a8085403652d587e42d`  
Target: Ubuntu 24.04, Node.js 22 LTS, 2 vCPU, 1.8 GB RAM.

## Executive verdict
**NO-GO for public production traffic.** The repository has a strong lightweight foundation—loopback binding, explicit route allowlist, HMAC API keys, tenant scoping, bounded concurrency, WAL SQLite, immutable releases, systemd sandboxing, encrypted backup scripts, deterministic lockfiles, and CI gates. It is not yet production-complete because runtime evidence is absent and several blueprint requirements remain unimplemented.

## Findings

### Critical — production OTP authentication bypass
- **File:** `.env.example`, `src/config.ts`, `src/http/console.ts`
- **Problem:** the documented production configuration selected development OTP delivery, which returns the login code to an unauthenticated caller.
- **Impact:** account takeover without access to the email inbox.
- **Root cause:** a development mode existed without an environment-level fail-closed invariant.
- **Recommendation:** reject this combination during startup.
- **Implementation:** ADR-010, typed `NODE_ENV`, production webhook requirement, URL+credential validation, tests, corrected environment contract.
- **Risk:** unsafe existing production configs will stop until the mail relay is configured; this compatibility break is mandatory.

### High — metrics contract is missing
- **File:** `src/http/app.ts`, `src/policy/allowlist.ts`, `docs/api/openapi.yaml`
- **Problem:** no `/metrics` endpoint or equivalent internal metrics exporter exists.
- **Impact:** saturation, error-rate, queue, latency, RSS, WAL, and budget anomalies cannot be alerted reliably.
- **Root cause:** observability currently covers structured logs only.
- **Recommendation:** add an internal-token-protected Prometheus endpoint with bounded-cardinality labels; never label by raw tenant, key, prompt, or provider credential.
- **Implementation:** pending.
- **Risk:** must avoid high-cardinality or per-request allocation overhead.

### High — session mutation CSRF is not explicit
- **File:** `src/http/console.ts`
- **Problem:** cookie-authenticated member mutations rely on `SameSite=Lax` and do not validate Origin or a CSRF token.
- **Impact:** defense degrades under browser behavior changes, compromised sibling origins, or future cookie-policy changes.
- **Root cause:** browser API routes were added without a centralized mutation guard.
- **Recommendation:** validate exact Origin for every cookie-authenticated mutation and add a session-bound CSRF token for defense in depth.
- **Implementation:** pending.
- **Risk:** requires coordinated console-client update.

### High — SSRF guard does not pin DNS resolution
- **File:** `src/policy/egress.ts`
- **Problem:** literal private IPv4 is blocked, but hostname resolution, private IPv6 ranges, and DNS rebinding are not controlled.
- **Impact:** configurable webhook targets could reach internal services.
- **Root cause:** URL syntax validation is used as a network policy.
- **Recommendation:** resolve all A/AAAA answers, reject non-public ranges, connect through a pinned dispatcher/agent, and revalidate every redirect (prefer redirects disabled).
- **Implementation:** pending; current outbound calls use HTTPS and redirects are not universally explicit.
- **Risk:** DNS policy must preserve legitimate Cloudflare/Google/Discord endpoints.

### High — OpenAPI is materially incomplete
- **File:** `docs/api/openapi.yaml`
- **Problem:** only liveness, models, and chat are described; Responses, Anthropic, readiness, console/webhook contracts, schemas, security errors, SSE, and request IDs are absent.
- **Impact:** generated clients and contract reviews diverge from implementation.
- **Root cause:** OpenAPI is manually maintained and not gated against the route allowlist.
- **Recommendation:** generate or validate OpenAPI from canonical schemas and fail CI when allowlisted public API routes lack operations.
- **Implementation:** pending.
- **Risk:** protocol dialects need separate error/stream schemas.

### High — production proof is absent
- **File:** deployment/runbook evidence
- **Problem:** no verified VPS install, bind check, resource snapshot, backup restore, rollback drill, Cloudflare Access negative test, or long-running soak result exists.
- **Impact:** repository quality cannot establish production readiness.
- **Root cause:** the available execution environment has no SSH or Cloudflare administrative connection.
- **Recommendation:** run the documented staging matrix against the exact release SHA before go-live.
- **Implementation:** blocked on operator/runtime access.
- **Risk:** release remains NO-GO.

### Medium — security headers and correlation ID are incomplete
- **File:** `src/http/app.ts`, `src/http/console.ts`
- **Problem:** selected page headers exist, but there is no centralized CSP, HSTS-at-edge contract, Permissions-Policy, `X-Content-Type-Options`, or separate trusted `X-Correlation-Id` handling.
- **Impact:** inconsistent browser hardening and cross-service tracing.
- **Root cause:** headers are applied per page instead of by one hook/policy.
- **Recommendation:** centralize headers by route class; sanitize/generate correlation IDs and propagate them upstream.
- **Implementation:** pending.
- **Risk:** CSP requires frontend asset review.

### Medium — synchronous SQLite and maintenance can create latency spikes
- **File:** `src/persistence/database.ts`, `src/main.ts`
- **Problem:** `better-sqlite3`, migrations, and WAL checkpointing run on the main event loop.
- **Impact:** checkpoint or write contention can delay streams on a 2-vCPU host.
- **Root cause:** simplicity and low memory were prioritized over isolation.
- **Recommendation:** keep SQLite for phase 1, measure event-loop delay, bound maintenance, and move checkpoint/backup work outside peak traffic before considering a worker thread.
- **Implementation:** partially mitigated by WAL, short transactions, cache bounds, and hourly maintenance.
- **Risk:** premature worker architecture would add complexity; measure first.

### Medium — CI lacks dependency vulnerability/SBOM and runtime smoke gates
- **File:** `.github/workflows/quality.yml`
- **Problem:** deterministic install, tests, secret scan, build, packaging, and checksum exist, but there is no vulnerability policy, SBOM, provenance, container/filesystem scan, or boot smoke test of the packaged artifact.
- **Impact:** vulnerable transitive packages or packaging/runtime regressions may pass.
- **Root cause:** initial CI focused on deterministic compilation.
- **Recommendation:** add `npm audit --omit=dev` policy with reviewed exceptions, CycloneDX/SPDX SBOM, artifact boot smoke test, and signed provenance.
- **Implementation:** pending.
- **Risk:** vulnerability feeds require a documented exception process to avoid noisy bypasses.

### Medium — Docker/Compose are intentionally absent
- **File:** repository root/infra
- **Problem:** no Dockerfile or Compose deployment exists despite the requested audit category.
- **Impact:** no container deployment path; not a defect for the documented systemd architecture.
- **Root cause:** blueprint explicitly chooses one lightweight Node service under systemd on the shared VPS.
- **Recommendation:** retain systemd as canonical. Add containers only if a second supported deployment model is approved by ADR.
- **Implementation:** no change (YAGNI).
- **Risk:** dual deployment paths would increase drift and maintenance.

### Low — repository layout differs from the aspirational monorepo blueprint
- **File:** `src/`, `web/`, blueprint section 8
- **Problem:** implementation uses a compact modular single package rather than `apps/` and `packages/` workspaces.
- **Impact:** minimal today; the current shape is easier to operate at this scale.
- **Root cause:** implementation optimized for the initial VPS envelope.
- **Recommendation:** document the compact layout as the phase-1 realization; split only when ownership or independent release boundaries justify it.
- **Implementation:** pending documentation alignment.
- **Risk:** premature decomposition would increase memory, build, and cognitive overhead.

## Coverage summary
- **Architecture/folders/code:** coherent modular single process; some large modules (`console.ts`, billing service) need decomposition as features grow.
- **Dependencies:** small runtime graph and lockfiles; vulnerability/SBOM evidence missing.
- **API/validation/auth/authz:** explicit allowlist, strict Zod schemas, HMAC keys/scopes/tenant checks are strong; OpenAPI and browser mutation controls incomplete.
- **Rate limit/cache/errors:** bounded in-memory source/key/tenant limits and no-store API policy; multi-instance coordination intentionally unsupported; error dialect mapping exists.
- **Config/env/secrets:** typed validation and root-owned env contract; critical OTP invariant corrected in this branch.
- **Logging/monitoring/health:** Pino redaction, liveness/readiness, request ID exist; metrics/correlation/alerts missing.
- **Systemd/deploy/rollback/backup:** strong static design; runtime drills unproven. Docker/Compose intentionally not canonical.
- **Performance/memory/scalability:** bounded 4 global/2 tenant concurrency, 192 MiB heap, 384 MiB cgroup, streaming and cancellation; single-process SQLite is appropriate until measured limits are exceeded.
- **Testing/docs/runbooks/scripts:** useful unit/integration/security coverage and release scripts; missing CSRF/Access-forgery/SSRF-DNS/malformed-SSE/backpressure/load/soak/runtime-drill evidence.

## Scores (evidence-based, 100 max)
- Overall architecture: **78**
- Security: **70** after OTP fix; **55** on unpatched main
- Performance: **78**
- Documentation: **74**
- Production readiness: **52**
- Enterprise readiness: **48**
- Memory optimization: **84**
- Deployment readiness: **63**

## Go-live gates
1. Merge and deploy the OTP fail-closed patch.
2. Add protected metrics and alerts.
3. Add cookie-mutation CSRF/Origin enforcement.
4. Complete SSRF DNS/IP pinning.
5. Make OpenAPI complete and CI-enforced.
6. Pass Access forged/missing/expired tests, HTTP IDOR, malformed SSE/backpressure, and mock load tests.
7. Execute staging health, resource, backup-restore, and rollback drills against the exact release SHA.
8. Observe a soak period with stable RSS/event-loop delay and no WAL growth anomaly.
