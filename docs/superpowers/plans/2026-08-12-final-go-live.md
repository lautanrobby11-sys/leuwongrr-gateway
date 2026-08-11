# Final Go-Live LeuwongRR Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship and activate the LeuwongRR Gateway console only after the A19 blocker, Model Catalog, API documentation, OTP relay, Cloudflare Access, release, host, and acceptance gates are independently verified.

**Architecture:** Keep the Gateway on loopback `127.0.0.1:2080` with its own SQLite `gateway.db`; keep OmniRoute on `127.0.0.1:20128` and `leuwongrr.online` on its own MySQL database. The public boundary remains Cloudflare Tunnel/Access and HTTP webhook communication. Business configuration stays in Gateway tables; secrets and infrastructure settings stay in `gateway.env`.

**Tech Stack:** Node.js 22, TypeScript, Fastify, SQLite via `better-sqlite3`, Zod, Vitest, Vite/React console, Cloudflare Worker, Resend, systemd, signed immutable release artifacts.

## Global Constraints

- Read `AGENTS.md`, `README.md`, the relevant ADRs, the repository audit, and the release-authority runbook before each sensitive slice.
- Do not touch OmniRoute files, database, config, or secrets.
- Do not use forbidden suffixes: `-new`, `-final`, `-final2`, `-fix`, `-fixed`, `-hotfix`, `-patch`, `-override`, `-override2`, `-backup`, `-old`, `-temp`, or `docker-compose.override.yml`.
- Do not add a public route without `src/policy/allowlist.ts` and OpenAPI synchronization.
- Schema changes are forward-only migrations in `src/persistence/migrations.ts`.
- Pricing, duration, token allowance, tier, reset policy, exchange rates, and model pricing belong in SQLite, not environment variables.
- Secrets, runtime, loopback, OTP delivery, and Cloudflare Access settings belong in `gateway.env`, never in source, database, logs, artifacts, or Notion.
- Gateway SQLite and `leuwongrr.online` MySQL must remain completely separate; communication is HTTP webhook only.
- No deployment, console activation, or DONE status while any required gate is red, partial, skipped-on-failure, unknown, or missing evidence.
- Never retry a SHA after deployment has created/used a release directory or passed into activation/health; create a new commit and repeat all gates.
- Goku owns planner/chat and Notion; Vegeta owns source, tests, commits, artifacts, release, and VPS; Boss owns approval and monitoring.
- Design questions go once through Goku; Goku records the decision and avoids duplicate/spam prompts to Boss.

---

### Task 1: Freeze and classify the current worktree

**Files:**
- Read: `AGENTS.md`, `README.md`, `docs/audits/2026-08-01-repo-audit.md`, `docs/adr/ADR-009-console-accounts-and-billing.md`, `docs/adr/ADR-010-production-otp-delivery.md`, `docs/adr/ADR-011-egress-metrics-and-console-origin.md`, `docs/adr/ADR-012-local-release-authority.md`, `docs/adr/ADR-013-artifact-signing.md`, `docs/runbooks/operator-release-authority.md`
- Inspect: `src/http/pipeline.ts`, `tests/stream-upstream-error.test.ts`, Model Catalog diff, `infra/cloudflare/otp-relay/`

**Interfaces:**
- Produces: a sanitized checkpoint containing branch, full HEAD SHA, clean/dirty state, changed paths, and ownership of every untracked path.

- [ ] **Step 1: Record the baseline without editing source**

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git diff --stat
git ls-files --others --exclude-standard
```

Expected: the current dirty Model Catalog/A19 work and `infra/cloudflare/otp-relay/` are explicitly classified; no file is silently deleted or hidden.

- [ ] **Step 2: Send one checkpoint to Goku and Vegeta**

Goku updates Notion with status `IN_PROGRESS` and no DONE claim. Vegeta pauses unrelated edits and reports only the files he owns. If the Worker directory is not confirmed as Gateway-owned and safe, leave it uncommitted and do not package it.

- [ ] **Step 3: Stop at the classification gate**

Do not run a production release from this worktree. A release checkout is created only after each atomic commit is merged/pushed and the tree is clean.

---

### Task 2: Reproduce and close A19 with a regression test

**Files:**
- Modify: `src/http/pipeline.ts`
- Test: `tests/stream-upstream-error.test.ts`
- Read: `src/upstream.ts`, `tests/upstream.test.ts`, `tests/support/harness.ts`

**Interfaces:**
- Consumes: `OmniRouteClient.request()` returns a body-wrapped `Response` whose permit is released on body completion, cancellation, or error.
- Produces: a streaming non-2xx path that cancels/discards the body before returning and a regression test proving a single upstream permit is reusable.

- [ ] **Step 1: Run the focused regression before accepting the fix**

```bash
npx vitest run tests/stream-upstream-error.test.ts
```

Expected: the test must demonstrate the pre-fix failure if the test is temporarily run against the parent behavior. Do not weaken the assertion or replace the body-bearing 502 with an empty response.

- [ ] **Step 2: Inspect the minimal fix**

The error branch must cancel the wrapped response body before returning. It must still release the Gateway budget, write a sanitized audit event, abandon idempotency where applicable, and preserve the 502 response contract. Do not alter unrelated stream accounting.

- [ ] **Step 3: Run focused tests**

```bash
npx vitest run tests/stream-upstream-error.test.ts tests/upstream.test.ts tests/stream-e2e.test.ts
```

Expected: all focused tests pass, including permit holding until body consumption and release after cancellation/error.

- [ ] **Step 4: Run the complete validation gate**

```bash
npm run validate
```

Expected: conventions, secret scan, lint, typecheck, and all tests pass. Any failure stops the plan.

- [ ] **Step 5: Review and commit only the A19 slice**

```bash
git diff -- src/http/pipeline.ts tests/stream-upstream-error.test.ts
git diff --check
git add src/http/pipeline.ts tests/stream-upstream-error.test.ts
git commit -m "fix: release upstream permit after streaming errors"
```

Do not stage Model Catalog, OpenAPI, Worker, docs, or unrelated files in this commit.

---

### Task 3: Complete and verify the Model Catalog slice

**Files:**
- Modify: `src/persistence/migrations.ts`, `src/http/console.ts`, `src/policy/allowlist.ts`, `docs/api/openapi.yaml`, `web/src/lib/api.ts`, `web/src/admin/main.tsx`
- Create: `src/models/catalog.ts`, `tests/model-catalog.test.ts`
- Read: `src/policy/capabilities.ts`, `src/persistence/database.ts`, Access verification code, existing console tests

**Interfaces:**
- Produces: `ModelCatalog`, `modelInputSchema`, `modelUpdateSchema`, admin GET/POST/PUT/DELETE model routes, and the model policy route with matching allowlist/OpenAPI contracts.
- Data contract: `id`, `name`, `provider`, `inputPriceCents`, `outputPriceCents`, `cacheReadPriceCents`, `multimodalSupport`, `upstreamModel`, and `enabled`.

- [ ] **Step 1: Verify migration 0006/0008 compatibility**

Confirm the existing `models` table and migration 0008 are forward-only, idempotent through the repository migration runner, and do not place pricing in environment variables. Confirm existing rows receive safe defaults and no production table is altered during local tests except disposable test databases.

- [ ] **Step 2: Run Model Catalog tests**

```bash
npx vitest run tests/model-catalog.test.ts
```

Required behavior: create, list, update, duplicate rejection, validation of negative/oversized values, unknown update/delete 404, Access/role guard, policy cleanup, and protection against deleting a model referenced by an active plan.

- [ ] **Step 3: Verify route and documentation parity**

```bash
node scripts/check-conventions.mjs
npm run typecheck
```

Read `src/policy/allowlist.ts` and `docs/api/openapi.yaml` together. Every method/path must match the route resolver; no wildcard or catch-all may be introduced.

- [ ] **Step 4: Review web behavior**

The admin model view must show persisted database values and must not claim automatic OmniRoute synchronization. Any UI mutation must use the same API schema and handle `ApiError` without exposing secrets or raw upstream responses.

- [ ] **Step 5: Commit the atomic Model Catalog slice**

```bash
git diff --check
git add src/models src/persistence/migrations.ts src/http/console.ts src/policy/allowlist.ts docs/api/openapi.yaml web/src/lib/api.ts web/src/admin/main.tsx tests/model-catalog.test.ts
git commit -m "feat: add database-backed model catalog"
```

---

### Task 4: Finish API documentation parity

**Files:**
- Modify: `docs/api/openapi.yaml`
- Read/verify: `src/policy/allowlist.ts`, route registration in `src/http/app.ts` and `src/http/console.ts`, documentation tests

**Interfaces:**
- Produces: an OpenAPI document that describes every allowlisted operation with correct method, path, auth, request schema, response/error envelope, and console-off behavior.

- [ ] **Step 1: Run the route/documentation contract tests**

```bash
npx vitest run tests/openapi*.test.ts tests/*policy*.test.ts
```

If the repository uses different matching filenames, run the exact existing contract test discovered by `rg -n "DOCUMENTED_OPERATIONS|openapi|allowlist" tests src`.

- [ ] **Step 2: Review only verified contracts**

Do not document unimplemented subscription or admin behavior. Include the Model Catalog operations only after Task 3 tests and route registration pass. Keep API client auth separate from Cloudflare Access admin auth.

- [ ] **Step 3: Commit documentation parity**

```bash
git diff --check
git add docs/api/openapi.yaml
git commit -m "docs: synchronize API contract with allowlist"
```

---

### Task 5: Review, test, and commit the OTP Worker boundary

**Files:**
- Review/create: `infra/cloudflare/otp-relay/src/index.ts`, `infra/cloudflare/otp-relay/wrangler.toml`, `infra/cloudflare/otp-relay/README.md`
- Modify only if required: `src/config.ts`, `.env.example`, `docs/adr/ADR-010-production-otp-delivery.md`, `infra/cloudflare/README.md`
- Test: Worker-local tests or a documented dry-run using fake Resend responses; never use production credentials in tests.

**Interfaces:**
- Consumes: `POST { email, code, ttl_minutes }` and `Authorization: Bearer <OTP_WEBHOOK_TOKEN>` from Gateway.
- Produces: explicit 400/401/405/502 responses; successful delivery returns a non-sensitive 2xx response; Resend credential is a Worker secret only.

- [ ] **Step 1: Inspect the Worker boundary**

Confirm the Worker validates email/code/TTL, rejects missing or wrong authorization, handles method mismatch, never logs OTP or provider response, and maps Resend failure to a non-2xx response the Gateway treats as delivery failure.

- [ ] **Step 2: Run secret and convention checks**

```bash
node scripts/check-conventions.mjs
node scripts/scan-secrets.mjs
```

Expected: no Worker token, Resend key, Cloudflare token, email credential, or sample that resembles a real secret appears in the tree.

- [ ] **Step 3: Commit only reviewed Worker source and docs**

```bash
git diff --check
git add infra/cloudflare/otp-relay
git commit -m "feat: add production OTP relay worker"
```

Do not put runtime secrets in the commit, artifact, or Notion.

---

### Task 6: Prepare external Cloudflare/Resend configuration without activation

**Files:**
- Runtime only: VPS#2 `/opt/leuwongrr-gateway/config/gateway.env`
- Canonical docs: `infra/cloudflare/README.md`, Notion Console ON checklist

**Interfaces:**
- Requires from the operator: Cloudflare API access or authenticated `wrangler`, Resend API key, verified sender, Access team domain, Access audience, and generated OTP webhook token.
- Produces: a sanitized configuration readiness record; `CONSOLE_ENABLED` remains `false` until Task 7 approval.

- [ ] **Step 1: Validate the external prerequisites**

Confirm the Worker URL is HTTPS, the Worker secret is installed via the provider secret store, the sender is verified, Access protects `api.leuwongrr.cloud/admin*` only, and `/v1/*` does not redirect to Access login.

- [ ] **Step 2: Install paired Gateway settings atomically**

Set `OTP_DELIVERY=webhook`, `OTP_WEBHOOK_URL`, `OTP_WEBHOOK_TOKEN`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and the already approved payment secret using root-owned mode `600`. Do not echo values. Keep `CONSOLE_ENABLED=false`.

- [ ] **Step 3: Run configuration preflight without activation**

Use the repository’s production config guard and record only pass/fail plus sanitized field names. A missing pair is a configuration-only refusal; do not create a release directory or restart the service.

- [ ] **Step 4: Update Notion through Goku**

Goku records `BLOCKED` for any missing external item and changes it to `VERIFIED` only after sanitized evidence is available. No credential values are recorded.

---

### Task 7: Build a release candidate from a clean full SHA

**Files:**
- Read: `scripts/assert-clean-tree.sh`, `scripts/build-release.sh`, `scripts/sign-release.sh`, `docs/runbooks/operator-release-authority.md`
- Generated outside tracked source: `.release/<full-sha>.tar.gz`, `.sha256`, `.sha256.sig`

**Interfaces:**
- Produces: a release candidate whose full commit SHA, package checksum, manifest, signature, and local CI evidence all match.

- [ ] **Step 1: Create a disposable clean checkout**

```bash
git fetch origin
git clone <private-origin> <disposable-directory>
git -C <disposable-directory> checkout <full-sha>
git -C <disposable-directory> status --short
```

Expected: empty status before dependency installation.

- [ ] **Step 2: Install both lockfiles and run local CI**

```bash
npm ci --no-audit --no-fund
npm --prefix web ci --no-audit --no-fund
npm run ci:local
```

Expected: all validation, backend/web build, shell, package, checksum, manifest, and clean gates pass.

- [ ] **Step 3: Sign and verify the artifact locally**

```bash
SHA=$(git rev-parse HEAD)
sha256sum -c ".release/$SHA.tar.gz.sha256"
bash scripts/sign-release.sh "$SHA"
ssh-keygen -Y verify -f keys/release-signers -I release-signer -n file \
  -s ".release/$SHA.tar.gz.sha256.sig" < ".release/$SHA.tar.gz.sha256"
git status --short
```

Never copy the signing private key or environment files to VPS#2.

- [ ] **Step 4: Record release evidence**

Record full SHA, artifact checksum, signer fingerprint, both lockfile installs, `ci:local` result, previous release SHA, migration ID, and rollback target. Goku mirrors only sanitized evidence to Notion.

---

### Task 8: Deploy the dark release and verify host safety

**Files:**
- Runtime: VPS#2 release directory, `current` symlink, `runtime/active-sha`, systemd state, SQLite migration state
- Read: `docs/runbooks/operator-release-authority.md`, `docs/runbooks/operations.md`

**Interfaces:**
- Consumes: signed artifact/checksum from Task 7.
- Produces: active full SHA with health, readiness, migrations, restart count, loopback binding, journal, backup, and rollback evidence.

- [ ] **Step 1: Transfer only the release inputs**

```bash
scp ".release/$SHA.tar.gz" ".release/$SHA.tar.gz.sha256" \
  ".release/$SHA.tar.gz.sha256.sig" admin@47.130.108.143:/tmp/
```

- [ ] **Step 2: Activate through the canonical script**

```bash
ssh admin@47.130.108.143 "sudo bash -n /opt/leuwongrr-gateway/current/scripts/deploy.sh"
ssh admin@47.130.108.143 "sudo bash /opt/leuwongrr-gateway/current/scripts/deploy.sh $SHA /tmp/$SHA.tar.gz"
```

If this invocation fails after it reaches release use, abandon the SHA and do not retry it.

- [ ] **Step 3: Verify the host**

Check `active-sha`, `systemctl`, `NRestarts`, `MemoryCurrent`, loopback listeners, `/health/live`, token-protected `/health/ready`, migration 0001 through the current migration, journal errors, and `CONSOLE_ENABLED=false` for the dark release.

- [ ] **Step 4: Run backup/restore and rollback drills**

Use `scripts/backup.sh` and `scripts/restore-drill.sh` according to the runbook, then verify the prior release remains a valid rollback target. Record sanitized results; do not expose backup identity material.

- [ ] **Step 5: Update GitHub/local/Notion checkpoint**

Vegeta reports exact evidence; Goku updates Notion to `DEPLOYED` only after the host evidence is complete. Local and GitHub must point to the same full SHA.

---

### Task 9: Single approved Console ON activation and acceptance

**Files:**
- Runtime: VPS#2 `gateway.env` and systemd service
- Test evidence: sanitized acceptance report

**Interfaces:**
- Consumes: all Task 6 prerequisites and Task 8 dark-deploy evidence.
- Produces: console-enabled production service or an explicit NO-GO; never a half-enabled state.

- [ ] **Step 1: Validate configuration pairings**

Confirm production boot guards accept webhook OTP, HTTPS Worker URL, OTP token, payment secret, Access domain/audience, console origin, and required runtime values. Keep console OFF if any guard refuses.

- [ ] **Step 2: Make one activation attempt**

Change only the approved runtime configuration, restart through the documented operator path, and run both health probes. This is the only activation attempt for the exact release SHA.

- [ ] **Step 3: Execute acceptance tests**

Verify:

1. `/login` is reachable without Access redirect;
2. OTP request returns delivered without exposing `dev_code`;
3. invalid/expired OTP is rejected;
4. member session reaches member routes only;
5. admin requires valid Access JWT and application role;
6. valid Access user without app role is rejected;
7. `/v1/*` does not require interactive Access;
8. payment webhook verifies HMAC, amount, status, and idempotency;
9. subscription order is Rolling Time → Token Pack → Wallet;
10. model catalog CRUD persists database values and soft-disable/guard behavior;
11. origin and CSRF negative cases fail closed;
12. no secret, prompt, or response appears in logs.

- [ ] **Step 4: Observe and soak**

Run the documented canary/soak window, check restart count, readiness, memory, WAL, journal, backup age, and public routes. Any post-activation failure means NO-GO and a new SHA is required for remediation.

- [ ] **Step 5: Record final status**

Goku writes the final Notion entry only after Vegeta supplies all evidence. Status is `GO-LIVE` only when no required blocker remains; otherwise it remains `BLOCKED` with the exact missing evidence.

---

## Verification checklist

- [ ] `git status --short` clean on the release checkout.
- [ ] `npm run validate` passed.
- [ ] `npm run ci:local` passed on the exact full SHA.
- [ ] GitHub required `validate` check is success.
- [ ] Artifact checksum, manifest, and signature verified.
- [ ] Gateway database remains separate from `leuwongrr.online` MySQL.
- [ ] VPS#2 active SHA, health, migrations, loopback, journal, backup/restore, and rollback evidence recorded.
- [ ] Console OTP, Cloudflare Access, origin, role, payment, subscription, model, and negative tests passed.
- [ ] Notion, GitHub, local checkout, and VPS report the same full SHA and status.
- [ ] No secret appears in code, database, logs, responses, artifact, evidence, or Notion.
