# Model Groups + Member Model Dropdown — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` to implement this plan task-by-task.

**Goal:** Introduce `Model ← Group ← Plan` so the DB catalog becomes the only
request-path source of truth, plans reference one group, members pick a model
from that group via a backend-driven dropdown, and multi-mode billing
(`rolling_time` / `token_pack` / `monetary_pack` / shared PAYG) settles on a
single fixed funding priority with no model fallback and no negative balance.

**Spec:** `docs/superpowers/specs/2026-08-14-model-groups-and-member-model-dropdown-design.md` (Revision 2 supersedes earlier multiplier-display-only / Bootstrap-required statements).

**Tech Stack:** TypeScript + Fastify + better-sqlite3, Zod, React (existing
primitives + Motion + single Lucide wrapper), Vitest.

## Global Constraints

- No deploy, no VPS build, no OmniRoute file/db/secret access, no GitHub creds to VPS.
- Project-facing content (UI, API errors, types, tests, OpenAPI, migration
  comments, feature docs) is **English**; conversation/coordination may be Indonesian.
- Existing React UI/icon system only — no Bootstrap runtime, no second icon library.
- Tenant policy becomes **deny-only** (default allow; explicit `model_policies.enabled=0` denies).
- No model fallback anywhere. No negative balance. No silent correction.
- Forward-only migrations. `models_json` read only by migration 0010 after this work lands.

## Architectural conflicts found (resolved in this plan)

1. **Static registry vs DB catalog.** `src/policy/capabilities.ts` currently
   holds the only model (`lwrr-text`) and is the request-path authority via
   `requireModel` in `app.ts:270`. It must shed its registry role (keep only
   `Capability` type + validation helpers) and the request path must resolve
   from the DB (`models`, `model_groups`, `plans`, `subscriptions`).
2. **`plans.models_json` entitlement copy.** `BillingService.applyPlanLimits`
   (service.ts:449) writes `model_policies` rows from `plan.models`. That
   allow-list mechanism is replaced by group-based entitlement + deny-only
   policy. `plan.models` disappears from the schema (rejected, not ignored).
3. **Dual price columns in `models`.** The table has legacy
   `*_price_per_m REAL` columns (written as `0`) alongside `*_price_cents`.
   Keep as-is; new code reads `*_price_cents` and applies the group multiplier
   once via one canonical helper.
4. **Billing currencies.** `wallets`/`subscriptions` are token-only today
   (`balance_tokens`, `included_tokens`/`used_tokens`). Spec adds
   `wallets.balance_cents`, `subscriptions.balance_cents`,
   `subscriptions.model_group_id`, and a `monetary_pack` method. This is a
   billing-engine change, not a thin UI change.
5. **`method` CHECK constraint.** Current `method IN ('rolling_time',
   'token_pack')` must grow to include `'monetary_pack'`. SQLite cannot alter a
   CHECK, so the migration rebuilds the `plans` and `subscriptions` tables.
6. **Migration split.** Spec names `0010_model_groups` for the catalog/groups,
   but Revision 2 adds accounting columns. We land **two** forward-only
   migrations: `0010_model_groups` (groups + model/plan group + capabilities +
   max_output_tokens + backfill) and `0011_multimode_accounting` (subscription
   snapshot, cents balances, `monetary_pack` method, usage breakdown/snapshot,
   currency-tagged ledger). Each is atomic and independently preflight-checked.

---

## Phase 1 — Catalog & groups (vertical slice 1)

### Task 1.1 — Migration `0010_model_groups`

**Files:**
- Modify: `src/persistence/migrations.ts`
- New: `tests/migration-0010.test.ts`

- [ ] Create `model_groups` (`id`, `name UNIQUE`, `multiplier_bps CHECK(>0)`, `enabled`, timestamps).
- [ ] `ALTER TABLE models ADD COLUMN group_id TEXT REFERENCES model_groups(id)`;
      `ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '["text","stream"]'`;
      `ADD COLUMN max_output_tokens INTEGER NOT NULL DEFAULT 4096 CHECK(>0)`.
- [ ] `ALTER TABLE plans ADD COLUMN model_group_id TEXT REFERENCES model_groups(id)`.
- [ ] Indexes `models_group_idx`, `plans_group_idx`.
- [ ] **Fail-closed backfill** runs inside the same transaction, before commit:
      1. parse every `plans.models_json`; normalize model ids;
      2. abort (rollback) if a plan references an absent model, if a plan has an
         empty/ambiguous membership that one-group cannot represent without
         expanding entitlement, if an active plan has no safe representable set,
         or if tenant policy `model_policies` contradicts the plan entitlement;
      3. only when entitlement-preserving: insert `legacy-default`
         (`multiplier_bps=10000`, `enabled=1`), set `models.group_id` and
         `plans.model_group_id` for `NULL`, and seed `lwrr-text`
         (`upstream_model='auto'`, capabilities `["text","stream"]`) when the
         table is empty so the request path still resolves.
- [ ] Do **not** union all models into every plan; do **not** guess tiers; do
      **not** enable a previously-unentitled model.
- [ ] Tests: applies cleanly on `0009`; `verifyDatabasePreflight` passes; backfill
      assigns `legacy-default`; idempotent re-run changes nothing; ambiguous
      membership aborts pre-commit; absent-model reference aborts.

### Task 1.2 — Capability source moves to catalog

**Files:**
- Modify: `src/models/catalog.ts` (add `group_id`, `capabilities`, `max_output_tokens` to schema/record/row + `list`/`get`), `src/policy/capabilities.ts` (keep `Capability` type, `parseCapabilities`, `maxOutputTokens` validation; drop registry).

- [ ] `modelInputSchema`/`modelUpdateSchema` gain `group_id` (nullable),
      `capabilities` (array, validated against `Capability`), `maxOutputTokens`
      (bounded by a `limit-bounds`-style constant), and `upstreamModel` max
      raised from 64 to a value verified sufficient for slash/dot identifiers
      (e.g. `tbs/gpt-5.6-luna`), with a test.
- [ ] `capabilities_json` parse/serialize helpers live in one place (catalog).
- [ ] Keep `enabled` on the model (still honored at resolution).

### Task 1.3 — `ModelGroupCatalog`

**Files:**
- New: `src/models/groups.ts`

- [ ] CRUD `list/create/update/remove`, `enabled` flag, `multiplier_bps`.
- [ ] `remove` returns `group_in_use` (409) when any plan references it.
- [ ] Assignment helpers `assignModel(groupId, modelId)` / `unassignModel(modelId)`
      set `models.group_id` directly (single owner), never touch `plans.*` or base prices.
- [ ] No `group_models` join table — membership is the single `group_id` column.

**Validation:** `npm run validate` after the slice.

---

## Phase 2 — Request-path resolver (vertical slice 2)

### Task 2.1 — Catalog resolver + error contract

**Files:**
- New: `src/policy/model-resolver.ts`
- Modify: `src/http/app.ts` (replace `resolveModel`), `src/models/catalog.ts`
- New: `tests/model-resolution.test.ts`

- [ ] `resolveModel(publicId, requiredCaps, tenantId)` runs the full chain:
      model exists → `model.enabled` → `group_id` present → group exists &
      enabled → active subscription/plan exists → `model.group_id ===
      plan.model_group_id` → tenant policy denies? → capability check →
      return `upstream_model`. Each failure is one structured code: `model_not_found`
      (404) / `model_unavailable` (404) / `model_not_entitled` (403) /
      `model_group_missing` (503) / `plan_group_missing` (503) /
      `capability_<x>_unsupported` (400).
- [ ] Remove `requireModel`'s registry use; `capabilities.ts` no longer resolves models.
- [ ] `resolveModel` re-runs every request (no cached authority); disable-during-
      session makes request N+1 fail with `model_unavailable`, never rewriting `model`.
- [ ] Errors never leak `upstream_model`, credentials, prompt, or response.
- [ ] Tests: full chain mapping; no-fallback (disabled model does not switch);
      block-after-disable during session.

### Task 2.2 — `/v1/models` + eligibility

**Files:**
- Modify: `src/http/app.ts` (`/v1/models` path uses the same resolver → eligible set only)
- New tests in `tests/model-resolution.test.ts`

- [ ] `GET /v1/models` lists exactly the eligible set (plan group ∩ enabled ∩
      policy-allowed ∩ valid capabilities); empty yields empty list, no auto-pick.

### Task 2.3 — Plan schema: `modelGroupId`, reject `models`

**Files:**
- Modify: `src/billing/plan-input.ts` (add `modelGroupId`, drop `models`),
      `src/billing/service.ts` (`Plan`, `PlanRow`, `toPlan`, `upsertPlan`,
      `applyPlanLimits`), `src/http/console.ts` (`/admin/plans`)
- New tests in `tests/model-resolution.test.ts` / existing plan tests

- [ ] Plan payload becomes `{ id, name, modelGroupId, monthlyPriceCents,
      includedTokens, overageCentsPerMillion, maxConcurrent, rateLimitRpm,
      dailyBudgetUnits, active }`. A `models` field → `400 invalid_request`
      (rejected, not ignored).
- [ ] Remove `models_json` from `toPlan`/`upsertPlan`; add `modelGroupId`.
- [ ] `applyPlanLimits` stops writing `model_policies` from `plan.models`;
      entitlement now derives from group membership at resolution. Tenant policy
      remains deny-only (an explicit disabled row denies; absence allows).
- [ ] `ModelCatalog.remove` guard changes from `models_json` scan to "model in a
      group referenced by an active plan" → `409 model_in_use_by_plan` (or the
      model is simply `Ungrouped` and unusable, delete allowed).
- [ ] Tests: `models` field → 400; plan update does not move models; group update
      does not change base prices; disabled group cannot be chosen by a new active plan.

**Validation:** `npm run validate`.

---

## Phase 3 — Multi-mode accounting (vertical slice 3)

### Task 3.1 — Migration `0011_multimode_accounting`

**Files:**
- Modify: `src/persistence/migrations.ts`
- New: `tests/migration-0011.test.ts`

- [ ] Rebuild `plans` with `method IN ('rolling_time','token_pack',
      'monetary_pack')`; backfill `model_group_id` already set by 0010.
- [ ] `subscriptions`: add `model_group_id`, `balance_cents INTEGER DEFAULT 0
      CHECK(>=0)`, extend `method` to include `monetary_pack`; keep legacy token fields.
- [ ] `wallets`: add `balance_cents INTEGER DEFAULT 0 CHECK(>=0)`; keep
      `balance_tokens`.
- [ ] `usage_events`: add immutable pricing/settlement columns — input/output/
      cache token breakdown, base prices, `multiplier_bps`, cost numerator,
      final cost cents, funding breakdown JSON, settlement status
      (`reserved|settled|released` already exists; add `settlement_failed` +
      unresolved amount + sanitized reason), model/group snapshot ids.
- [ ] `ledger_entries`: add `currency TEXT CHECK(currency IN ('tokens','cents'))`
      so token and cents entries cannot be confused; default sensible for legacy.
- [ ] Tests: applies on `0010`; preflight passes; currency check enforced;
      `settlement_failed` state reachable.

### Task 3.2 — Canonical multiplier helper

**Files:**
- New: `src/billing/pricing.ts` (+ shared bound `MULTIPLIER_BPS`)
- New: `tests/multiplier.test.ts`

- [ ] `effectiveCents(baseCents, multiplierBps) = ceil(baseCents * multiplierBps / 10000)`.
- [ ] Single billing boundary calls it; model-price settlement aggregates
      input/output/cache before one final `ceil` (`101×12500/10000 = 127`).
- [ ] Tests: `127` invariant; applied once (never 158 / never doubled).

### Task 3.3 — Funding priority engine (rewrite `applyUsage`)

**Files:**
- Modify: `src/billing/service.ts` (`applyUsage`, `summary`, `assertFunded`,
      `startSubscription`, `Subscription` snapshot), `src/http/pipeline.ts`
      (reservation ↔ settlement wiring)
- New/Modify: `tests/billing-settlement.test.ts`, `tests/subscription-engine.test.ts`

- [ ] Fixed priority `rolling_time → token_pack → monetary_pack → PAYG wallet → 402
      insufficient_balance`.
- [ ] Raw token pack deducts tokens only; records equivalent cost (informational,
      `Charged to balance: 0`). Monetary/PAYG deduct effective cents.
- [ ] Funding-source chaining: a pack may fund part; remainder proceeds to next
      source (an 800-token reservation from a pack + 400-token monetary reservation).
- [ ] Atomic reservation before upstream call; actual usage replaces estimate;
      unused released. No balance may go negative.
- [ ] Actual overrun exceeding all reservations with uncovered monetary shortfall
      → `settlement_failed`, no retry, no negative debit, no silent correction;
      subsequent requests blocked until audited reconciliation.
- [ ] Multiple valid active subscriptions contribute candidate sources; rolling-time
      first, then token packs by earliest expiry, then monetary; `past_due` grants
      nothing; expired/exhausted skipped.
- [ ] Tail: keep strict ledger discipline — reconciliation is an audited ledger
      op, never a direct balance edit.
- [ ] Tests: priority order; chaining; `settlement_failed` without negative balance;
      block-until-reconcile; multiple keys share one balance (no per-key balance).

### Task 3.4 — Immutable usage + dashboard contract

**Files:**
- Modify: `src/http/console.ts` (member `overview`/`usage`/new `cost`/`logs`),
      `src/billing/service.ts`
- New/Modify tests

- [ ] Usage stores timestamp, model, group, token breakdown, funding source, status.
- [ ] Cost stores base prices, multiplier, effective prices, equivalent cost,
      charged cents, currency, settlement status.
- [ ] Logs store request id, timestamp, safe API-key label, model/group, status,
      duration, usage, funding source, settlement status, error code — never prompt,
      response, plaintext key, upstream id, credentials.
- [ ] Member dashboard reads from immutable sanitized records, not recomputed from
      mutable catalog.

**Validation:** `npm run validate`.

---

## Phase 4 — Admin & member API (vertical slice 4)

### Task 4.1 — Model-groups admin routes

**Files:**
- Modify: `src/http/console.ts`, `src/policy/allowlist.ts` (+ `DOCUMENTED_OPERATIONS`), `docs/api/openapi.yaml`
- New/Modify tests (`tests/openapi-contract.test.ts`, admin route tests)

- [ ] `GET/POST /console/api/admin/model-groups`, `PUT/DELETE /console/api/admin/model-groups/:id`.
- [ ] `POST /console/api/admin/model-groups/:id/models` (assign/move),
      `DELETE /console/api/admin/model-groups/:id/models/:modelId` (unassign).
- [ ] Group payload `{ id, name, multiplierBps, enabled }`; response includes
      `{ modelsCount, activeModelsCount, plansCount }`. Delete referenced → 409.
- [ ] `requireAdmin` (Cloudflare Access + role) on every route (401 without).
- [ ] Keep `allowlist.ts`, `DOCUMENTED_OPERATIONS`, `openapi.yaml` in agreement
      (existing test enforces this).
- [ ] Tests: CRUD + move + unassign + referenced-delete 409 + auth 401 +
      anti-overlap (one endpoint does assignment; no duplicate).

### Task 4.2 — Member plans + eligible models payload

**Files:**
- Modify: `src/http/console.ts` (`/console/api/member/plans`), `src/billing/service.ts`
- New tests

- [ ] Response per plan: `{ id, name, modelGroup: { id, name, multiplierBps,
      multiplier, models: [...] } }` with effective prices
      (`effectiveInputPriceCents` etc.), `multimodalSupport`, `cacheReadPriceCents` —
      **never** `upstreamModel`.
- [ ] Eligible = plan active ∧ group enabled ∧ model enabled ∧ model in plan group
      ∧ tenant policy allows ∧ capabilities valid. Empty → clear "No models
      available"; subscribe never auto-picks.

**Validation:** `npm run validate`.

---

## Phase 5 — Frontend (vertical slice 5)

### Task 5.1 — Admin UI (groups → models → plans)

**Files:**
- Modify: `web/src/admin/main.tsx`, `web/src/lib/api.ts`, `web/src/components/icons.tsx` (add canonical names only)

- [ ] Groups page: `Group | Multiplier | Models | Plans | State | Action`; create/edit;
      open a group to assign/move/unassign models and view plans.
- [ ] Models page: `Model | Provider | Group | Base price | Effective preview | State |
      Action`; form with id, name, provider, upstream model (owner/admin only),
      capabilities, base prices, group, enabled; server-authoritative effective-price preview.
- [ ] Plans page columns: `Plan | Price | Included | Group | Limits | State | Action`;
      `PAYG / M` stays in the edit modal, not the main table.
- [ ] Reuse existing React primitives (Card/Button/Field/Modal/Toast/icons), Motion,
      single icon wrapper. No Bootstrap runtime, no second icon library, no raw `<svg>`.
- [ ] Tests (dom): group table renders; effective preview; no raw `<svg>` outside `icons.tsx`.

### Task 5.2 — Member + chat backend-driven dropdown

**Files:**
- Modify: `web/src/member/main.tsx`, `web/src/chat/main.tsx`, `web/src/lib/api.ts`
- New/Modify dom tests

- [ ] Member UI stores only `selectedPlanId` + `selectedModelId`; group derived from
      plan response (no independent `selectedGroupId`). Model select disabled until
      group valid; effective price beneath choice.
- [ ] Chat payload = `{ model, messages }` only — never `group`/`upstream_model`.
- [ ] On failure: keep user message, show mapped error, offer retry after admin fix;
      no silent model swap.
- [ ] Empty dropdown → "No models available" state.

**Validation:** `npm run validate`.

---

## Phase 6 — Final validation & evidence

### Task 6.1 — Whole-repo gate

- [ ] `npm run validate` — conventions, secrets scan, lint, typecheck, tests.
- [ ] `npm run ci:local` — plus `build:all` and `ci-shell-gates`.
- [ ] Review diff for: secret leakage, dual ownership, forbidden `-new/-final/-fix` suffixes, catch-all routes.
- [ ] Runtime read-only DB verification plan documented (post-deploy, `sqlite3 -readonly`:
      `0010`/`0011` present; `legacy-default` exists; every `models.group_id` non-null;
      active `plans.model_group_id` valid; `PRAGMA foreign_key_check` clean; currency/
      snapshot/capability/multiplier checks).

### Task 6.2 — Notion status

- [ ] Update canonical Notion (`7929024abd2483f8bfb181327c508e4d`) progress without secrets.
- [ ] No merge/deploy until gates green with local evidence + release-authority procedure.

---

## Acceptance criteria (checklist)

- [ ] `Model → Group → Plan → Subscription → request` fully wired; one model → one group.
- [ ] Subscription snapshots `model_group_id`; DB catalog is the request-path source of truth.
- [ ] No fallback; tenant policy deny-only; multiple keys share subscription/token/monetary/PAYG.
- [ ] Funding priority `rolling_time → token_pack → monetary_pack → PAYG → 402`; chaining works;
      `settlement_failed` on uncovered overrun with no negative balance.
- [ ] Multiplier applied once; raw token pack records equivalent cost without monetary debit.
- [ ] Immutable usage/cost/price-spread/funding/status + sanitized logs; member dashboard
      `Usage` / `Cost` / `Request logs` English sections.
- [ ] Backend-driven dropdown (chat/member); legacy migration fail-closed.
- [ ] `npm run validate` + `npm run ci:local` green locally; all behavioural tests pass.
- [ ] Red gate = STOP (no merge/deploy without green gates + local evidence).
