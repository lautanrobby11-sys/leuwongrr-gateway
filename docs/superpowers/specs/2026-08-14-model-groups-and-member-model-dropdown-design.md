# Model Groups + Member Model Dropdown — Design

- Date: 2026-08-14
- Status: Approved for planning
- Owner: single owner full control (`dk.san70@gmail.com`)
- Related: `AGENTS.md`, `README.md`, ADR-009 (console/accounts/billing),
  `docs/audits/2026-08-01-repo-audit.md`, memory `plans-model-groups`

## Goal

Introduce a `Model ← Group ← Plan` model so the owner registers models manually,
groups them with a single price multiplier, and attaches exactly one group to a
plan. Members choose a model from their plan's group through a dropdown; the
backend re-validates every request and remains authoritative. No silent
fallback: an invalid choice fails and the administrator fixes the configuration.

## Non-goals

- No OmniRoute discovery. Models are entered manually (system boundary).
- No per-plan model pin list. Members are free within the plan's group.
- No automatic re-classification of legacy models into Frontier/Value/Standard.
- No dropping of the legacy `plans.models_json` column (higher-risk, unneeded).

## Approved decisions

1. Members are free to use any enabled model inside their plan's group.
2. A plan references exactly one group (`plans.model_group_id`).
3. A model belongs to exactly one group (`models.group_id`, single value).
4. No fallback on failure — the request fails with a structured error.
5. Legacy migration: create `legacy-default` only when a preflight proves the
   transformation preserves every existing plan entitlement; otherwise fail
   before commit and require owner cleanup. No guessing of tiers.
6. Database catalog is the single request-path source of truth (approach A).
7. Anti-overlap: one owner per datum, one relation column, one canonical
   endpoint, one runtime resolver, one icon source.

## Architecture and data flow

The database catalog becomes the only request-path source of truth. The static
registry in `src/policy/capabilities.ts` stops being a second model registry; it
keeps only capability types/constants and validation helpers.

Relations:

```
Model  -> belongs to exactly one Group (models.group_id)
Group  -> contains many Models, has one multiplier, referenced by many Plans
Plan   -> references exactly one Group (plans.model_group_id)
Sub    -> gets the Plan's Group
Request-> chooses one Model from that Group
```

Per-request resolution (re-run every request, no caching of authority):

```
public model id
  -> model exists
  -> model.enabled
  -> model.group_id present
  -> group exists and enabled
  -> active subscription/plan exists
  -> model.group_id === plan.model_group_id
  -> tenant model policy allows this model
  -> capability supports the request
  -> use catalog.upstream_model
```

`GET /v1/models` uses the same resolver and only lists eligible models, so the
dropdown, `/v1/models`, and execution never disagree.

## Schema (migration `0010_model_groups`, forward-only, atomic)

```sql
CREATE TABLE model_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  multiplier_bps INTEGER NOT NULL CHECK(multiplier_bps > 0),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
ALTER TABLE models ADD COLUMN group_id TEXT REFERENCES model_groups(id);
ALTER TABLE models ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '["text","stream"]';
ALTER TABLE models ADD COLUMN max_output_tokens INTEGER NOT NULL DEFAULT 4096 CHECK(max_output_tokens > 0);
ALTER TABLE plans ADD COLUMN model_group_id TEXT REFERENCES model_groups(id);
CREATE INDEX models_group_idx ON models(group_id);
CREATE INDEX plans_group_idx ON plans(model_group_id);
```

Multiplier is basis points: `1.00 = 10000`, `1.25 = 12500`, `1.50 = 15000`;
displayed as `1.25x`. Bounds enforced in application code (a `limit-bounds`-style
constant shared by server schema and browser form to avoid UI/route drift):
`MULTIPLIER_BPS = { min: 1, max: 1_000_000 }` (1.00x floor at 10000 is a product
choice, not a DB floor; DB only enforces > 0).

Capabilities and `max_output_tokens` move into the catalog so the request path
can stop depending on the static registry. Values are entered manually; nothing
is read from OmniRoute.

### Backfill (deterministic, idempotent)

1. Insert group `legacy-default` (`name='Legacy Default'`, `multiplier_bps=10000`,
   `enabled=1`) if absent.
2. `UPDATE models SET group_id='legacy-default' WHERE group_id IS NULL`.
3. `UPDATE plans SET model_group_id='legacy-default' WHERE model_group_id IS NULL`.
4. Seed the legacy request-path model into the catalog if the table is empty, so
   `lwrr-text` (`upstream_model='auto'`, capabilities `["text","stream"]`) keeps
   working after the resolver switches to the database.
5. `plans.models_json` is read here once and never again by authorization.

`legacy-default` is a compatibility container only, not a statement that models
belong there permanently. The owner reorganizes groups explicitly afterward.
Migration never guesses tiers from names or prices.

## Ownership matrix (anti-overlap)

| Data | Sole owner | Must not be written by |
|---|---|---|
| Model identity, base prices, enabled, capabilities, `upstream_model`, `group_id` | `ModelCatalog` | Plan service, UI, static registry |
| Group name, multiplier, enabled | `ModelGroupCatalog` | Model service, Plan service |
| Plan → group (`model_group_id`) | `BillingService.upsertPlan` | Model/group service, member UI |
| Tenant model policy | `TenantStore` | Plan/group UI |
| Effective price | one canonical billing helper | Model/plan CRUD, frontend |
| Request model resolution | one request-path resolver | UI, static registry, any fallback |
| Icon mapping | `web/src/components/icons.tsx` | any page, any second icon library |

Rules that prevent wild overrides:

- One model → one `group_id`; unassign sets `NULL` (model becomes `Ungrouped`,
  invisible to members, unusable by requests, no fallback). No `group_models`
  join table, so there is no membership to keep in sync.
- `plans.models_json` is read only by migration `0010`; the new plan API rejects
  a `models` field with `400 invalid_request` (rejected, not silently ignored)
  so a legacy writer cannot revive model-list authorization.
- Group CRUD never writes `plans.*`, subscriptions, tenant policy, or base
  prices. Plan CRUD never moves models or changes multipliers.
- Multiplier applied exactly once at the billing boundary; plans never multiply,
  the executor never multiplies again.
- Partial updates use existing values for omitted fields; payloads are `strict`
  and reject unknown fields; entitlement-affecting writes read current state
  inside a transaction (no stale read-modify-write from UI data).

## Admin API (resource-oriented, no duplicate endpoints)

```
GET    /console/api/admin/model-groups
POST   /console/api/admin/model-groups
PUT    /console/api/admin/model-groups/:id
DELETE /console/api/admin/model-groups/:id
POST   /console/api/admin/model-groups/:id/models          (assign/move a model)
DELETE /console/api/admin/model-groups/:id/models/:modelId (unassign)
```

Group payload: `{ id, name, multiplierBps, enabled }`. Group response includes
`{ modelsCount, activeModelsCount, plansCount }`. Assignment always performs
`UPDATE models SET group_id=?` (moving from another group is explicit; response
returns the new group). No second endpoint (`/models/:id/group`) does the same.

Plan payload becomes `{ id, name, modelGroupId, monthlyPriceCents, includedTokens,
overageCentsPerMillion, maxConcurrent, rateLimitRpm, dailyBudgetUnits, active }`.
`models` is rejected. Deleting a group referenced by any plan → `409 group_in_use`.
A disabled group cannot be chosen by a new active plan.

All new routes are added to `src/policy/allowlist.ts` and its
`DOCUMENTED_OPERATIONS` mirror plus `docs/api/openapi.yaml` (a test keeps the
three in agreement, so an undocumented route fails CI).

## Member API

`GET /console/api/member/plans` returns each plan with its group and eligible
models as display data only — never `upstreamModel`:

```json
{ "id":"starter","name":"Starter",
  "modelGroup":{ "id":"value","name":"Value","multiplierBps":12500,"multiplier":1.25,
    "models":[{ "id":"lwrr-gpt-56","name":"GPT 5.6","multimodalSupport":true,
      "inputPriceCents":120,"outputPriceCents":600,"cacheReadPriceCents":30,
      "effectiveInputPriceCents":150,"effectiveOutputPriceCents":750,
      "effectiveCacheReadPriceCents":38 }] } }
```

Eligible = plan active AND group enabled AND model enabled AND model in plan's
group AND tenant policy enabled AND capabilities valid. Empty list shows a clear
"No models available" state; subscribe never auto-picks another model.

## Request-path error contract (no fallback)

| Code | HTTP | Meaning |
|---|---|---|
| `model_not_found` | 404 | public id not registered |
| `model_unavailable` | 404 | model disabled or its group disabled |
| `model_not_entitled` | 403 | model not in plan's group / tenant policy denies |
| `model_group_missing` | 503 | catalog invariant broken (model has no group) |
| `plan_group_missing` | 503 | active plan has no valid group |
| `capability_*_unsupported` | 400 | request needs a capability the model lacks |

Disable-during-session: request N succeeds if valid at resolution; request N+1
fails with `model_unavailable`; the executor never rewrites `model`. Errors never
mention `upstream_model`, credentials, prompt, or response.

## Billing multiplier (applied once)

Canonical helper (integer-only, no float drift):

```ts
export function effectiveCents(baseCents: number, multiplierBps: number): number {
  return Math.ceil(baseCents * multiplierBps / 10000);
}
```

Base prices stay in `models`. Plans carry only the group. The executor does not
recompute price. The helper is called at one billing boundary; other callers
receive the result. Example invariant: `101 × 12500 / 10000 → ceil(126.25) = 127`
(never 158, never multiplied twice).

## Frontend — lightweight existing design system, single icon source

The console currently ships its own React UI primitives, utility styling, Motion,
and a single icon component. New/changed UI reuses those primitives with
Bootstrap-inspired responsive semantics where useful (`card`, `table`,
`form-select`, `form-control`, `btn`, `badge`, `alert`, and `modal` patterns),
but adds no Bootstrap runtime and no second UI-state source. Modals/dropdowns
remain React-controlled so the bundle stays light.

Icon policy (anti-double / anti-duplicate):

- `web/src/components/icons.tsx` is the only icon owner. No raw inline `<svg>` in
  pages, no emoji for state/action, no mixing icon libraries at runtime.
- One semantic → one canonical name. Suggested Bootstrap-vocabulary mapping:
  `dashboard=speedometer2, plans=card-list, models=cpu, groups=collection,
  accounts=people, payments=wallet2, edit=pencil, delete=trash,
  enabled=check-circle, disabled=slash-circle, warning=exclamation-triangle`.
- Decorative icons `aria-hidden="true"`; icon-only buttons require `aria-label`;
  destructive action uses a single `trash` icon; status is one icon + text badge.
- A test asserts no raw `<svg>` and no direct icon-library import outside
  `icons.tsx`.

### Admin flow

- Groups page: table `Group | Multiplier | Models | Plans | State | Action`;
  new/edit group; open a group to assign/move/unassign models and see plans.
- Models page: registry with `Model | Provider | Group | Base price |
  Effective preview | State | Action`. Form: id, name, provider, upstream model
  (owner/admin only), capabilities, base prices, group, enabled. Selecting a
  group shows a server-authoritative effective-price preview.
- Plans page table becomes exactly `Plan | Price | Included | Group | Limits |
  State | Action`. `PAYG / M` leaves the main table (allowed in the edit modal).

### Member flow

Member UI stores only `selectedPlanId` and `selectedModelId`. The group is
derived from the plan response, not an independent selection, so there is no
`selectedGroupId` that can disagree. Group may render as a read-only/single-option
select for context. Model select is disabled until group data is valid; effective
price shows beneath the choice; mobile full-width, desktop full table. The chat
payload sends only `{ model, messages }` — never `group` or `upstream_model`.

Chat error UX: on failure the conversation keeps the user message, shows the
mapped error text, and offers retry after the admin fixes configuration. No
silent model swap.

## Testing matrix (behavioural)

Migration / persistence:
1. `0010` applies cleanly on a `0009` database; `verifyDatabasePreflight` passes
   (applied set equals `MIGRATIONS` ids).
2. Backfill: existing models get `legacy-default`; existing plans point at it;
   `lwrr-text` seeded so the request path still resolves.
3. Idempotent: re-running the backfill statements changes nothing.

Anti-overlap (must all pass):
4. Plan payload with `models` → 400.
5. Two assignments of one model → single `group_id`, not two memberships.
6. Moving a model does not change any `plans.model_group_id`.
7. Plan update does not change model assignment.
8. Group update does not change model base prices.
9. Multiplier applied once (`101×12500/10000=127`).
10. Static registry not used to resolve a request (resolver reads DB).
11. Disabled model does not fall back to another model.
12. Legacy `models_json` not read after migration (authorization ignores it).
13. No duplicate endpoint performs model→group assignment.
14. No raw icon/SVG outside `icons.tsx`.

Request path / API:
15. Full resolver chain: not_found / unavailable / not_entitled / group_missing
    / capability each return the mapped code.
16. `/v1/models` lists exactly the eligible set.
17. Group CRUD: create/list/update/enable-disable; delete referenced by plan → 409.
18. Model assign/move/unassign; unassigned model is `Ungrouped` and unusable.
19. Member plans response carries effective prices and no `upstreamModel`.
20. Admin routes require a valid Cloudflare Access assertion (401 without).

`upstreamModel` schema bound raised in `src/models/catalog.ts` from `.max(64)` to
accommodate upstream identifiers like `tbs/gpt-5.6-luna`; pattern loosened only
as far as verified necessary, with a test for a slash/dot identifier.

## Runtime DB verification (read-only, production)

After deploy, verify against `/opt/leuwongrr-gateway/data/gateway.db` with
`sqlite3 -readonly` (never write): `schema_migrations` contains `0010_model_groups`;
`model_groups` has `legacy-default`; every `models.group_id` is non-null and
references an existing group; every active `plans.model_group_id` references an
existing group; no orphan references (`PRAGMA foreign_key_check`).

## Security invariants (unchanged)

Non-loopback bind refused; API keys HMAC-SHA256 with runtime pepper; business
queries carry `tenant_id`; prompts/responses never logged; `/admin*` requires
Cloudflare Access JWT and app role; egress via SSRF guard; no provider secret in
repo, DB, logs, responses, or Notion.

## Acceptance criteria

- `npm run validate` and `npm run ci:local` green locally (workstation), not
  GitHub-only.
- All behavioural tests above pass; migration is forward-only.
- Runtime DB verification passes read-only on the deployed SHA.
- Notion canonical (`7929024abd2483f8bfb181327c508e4d`) and Gate 3
  (`3ba9024abd24817eb0c5e4cb2baf7d85`) updated per progress, no secrets.
- Red gate = STOP: no merge/deploy without green gates and local evidence.

## Revision 2 — multi-mode accounting and corrected migration safety

This section supersedes any earlier statement that a single legacy group may be
used unconditionally, that the multiplier is display-only, or that Bootstrap is
a required frontend dependency. It incorporates the owner-approved billing
choices from 2026-08-14.

### Project language

Conversation and coordination may use Indonesian. New or modified
project-facing content uses English: web copy, API errors/messages, new types,
tests, OpenAPI descriptions, migration comments, and runbook/spec content.
Unrelated existing Indonesian copy is not rewritten.

### Legacy migration is fail-closed

The migration must inspect every existing `plans.models_json` value before
assigning groups. It normalizes and validates all referenced model IDs and
compares plan memberships. It aborts inside the migration transaction, before
committing any catalog or group changes, when any of these is true:

- a plan references a model absent from `models`/the request catalog;
- legacy plan memberships overlap partially in a way that one-model/one-group
  cannot represent without expanding a plan's entitlement;
- an active plan has no safely representable model set;
- existing tenant policies contradict the legacy plan entitlement;
- the backfill would enable a model that the plan did not previously allow.

A single `legacy-default` group is created only when the transformation is
entitlement-preserving. The migration never unions all legacy models into every
plan, never guesses tiers, and never enables a previously unentitled model.
Owner cleanup is required before retrying an ambiguous production database.

### Subscription entitlement snapshot

A subscription stores `model_group_id` at purchase time. `plan_id` remains for
history/display, but request authorization uses the snapshot. Existing
subscriptions therefore do not silently change when a plan or group is edited.
Live safety controls still apply: disabling a model or group blocks the next
request, with no model replacement.

The existing engine's multiple-subscription behavior is made explicit:
valid active subscriptions contribute candidate funding sources; rolling-time
subscriptions are checked first, then token packs by earliest expiry, then
monetary subscriptions, then the shared PAYG wallet. A `past_due` subscription
cannot grant new allowance. Expired windows and exhausted packs are skipped.

### Three funding modes and currencies

The accounting engine keeps currencies separate:

- `token_pack`: raw token allowance (`included_tokens`, `used_tokens`);
- `monetary_pack`: cents allowance (`balance_cents`);
- `rolling_time`: time window (`activated_at`, `expires_at`);
- PAYG: one shared account wallet (`wallets.balance_cents`).

API keys never own balances or subscriptions. All keys under one tenant share
these instruments; each key still has its own scope, lifecycle, rate-limit
identity, and safe log identifier.

Funding priority is fixed:

```text
rolling_time -> token_pack -> monetary_pack -> PAYG wallet -> 402 insufficient_balance
```

A token pack may fund only part of a request. The remaining actual/estimated
usage proceeds to the next source. For example, an 800-token reservation from
a pack can be followed by a 400-token-equivalent monetary/PAYG reservation.
This is funding-source chaining, not model fallback.

### Reservation and settlement safety

Funding is reserved atomically before the upstream call. Actual usage replaces
the estimate; unused reservations are released. No wallet or monetary balance
may become negative. If actual usage exceeds all reservations and the monetary
shortfall cannot be covered, the request is not retried and the record is marked
`settlement_failed`; no negative debit and no silent correction are allowed.
The immutable usage record stores the unresolved amount, a sanitized reason,
and an operator reconciliation reference. Subsequent requests are blocked until
reconciliation clears the unresolved state. Reconciliation itself is an audited
ledger operation, never a direct balance edit.

### Model-price settlement

Model prices are cents per million tokens. For monetary funding, aggregate all
usage categories before one final ceiling:

```text
base_numerator = input_tokens * input_price_cents
               + output_tokens * output_price_cents
               + cache_read_tokens * cache_read_price_cents
effective_numerator = base_numerator * multiplier_bps
effective_cost_cents = ceil(effective_numerator / 10_000 / 1_000_000)
```

The multiplier is applied exactly once. A raw token pack deducts raw tokens and
records the same effective cost as an informational equivalent; it does not
deduct money. Monetary subscriptions and PAYG deduct effective cents.
Historical usage stores the model/group IDs, three base prices,
`multiplier_bps`, token breakdown, numerator, final cost, funding breakdown,
and settlement status. Later admin price changes cannot rewrite history.

### Accounting schema additions (forward-only)

The implementation plan must introduce, with explicit invariants and indexes:

- `models.group_id`, catalog capability data, and `max_output_tokens`;
- `plans.model_group_id`;
- `subscriptions.model_group_id` and `subscriptions.balance_cents`;
- `wallets.balance_cents` without deleting legacy token fields;
- usage token breakdown, pricing snapshot, funding breakdown, cost, reservation,
  and settlement status;
- currency-aware ledger linkage so token and cents entries cannot be confused.

Nullable foreign keys are allowed only where the business state explicitly
allows `Ungrouped` models or legacy transition rows. Startup/release preflight
must separately reject enabled models, active plans, or active subscriptions
that lack a valid group snapshot.

### Dashboard contract

The member dashboard has separate English sections for `Usage`, `Cost`, and
`Request logs`. Usage and cost data are read from immutable sanitized usage
records, not recomputed from mutable current catalog values.

Usage includes timestamp, model, group, input/output/cache tokens, total
units, funding source, and status. Cost includes base prices, multiplier,
effective prices, equivalent cost, charged amount, currency, and settlement
status. Logs include request ID, timestamp, safe API-key label, model/group,
status, duration, usage, funding source, settlement status, and error code.

For raw token funding, the UI labels the amount as `Equivalent cost` and shows
`Charged to balance: 0`. For monetary/PAYG funding it shows the actual cents
debited. Prompt, response, plaintext key, upstream identifier, credentials,
and payment secrets are never stored or displayed.

### Frontend scope correction

The repository keeps its existing React UI primitives, utility styling,
Motion usage, and single Lucide wrapper. No Bootstrap runtime or second icon
library is added. New/changed screens use English copy, responsive existing
components, one canonical icon owner, and React-controlled modal/select state.
A full Bootstrap design-system migration is explicitly out of scope.

### Revised acceptance gates

In addition to the earlier gates, implementation must prove:

- ambiguous legacy membership fails before migration commit;
- multiple API keys share one tenant/account balance without duplication;
- all three subscription modes and PAYG use the fixed priority order;
- token shortfall chains to the next source without model fallback;
- actual overrun produces `settlement_failed` without negative balance;
- historical pricing snapshots remain unchanged after catalog edits;
- dashboard usage, cost, and logs are sourced from immutable sanitized records;
- unresolved settlement blocks subsequent requests until audited reconciliation;
- runtime read-only checks cover wallet/ledger currency, active subscription
  snapshots, capability JSON, multiplier bounds, pricing snapshots, and stale
  policy references, not only foreign keys.
