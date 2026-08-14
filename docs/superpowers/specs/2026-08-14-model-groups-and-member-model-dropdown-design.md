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
5. Legacy migration: create one `legacy-default` group, move existing models
   into it, point existing plans at it. No guessing of tiers.
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

## Frontend — light Bootstrap 5, single icon source

The console currently ships its own UI primitives and a single icon component.
New/changed UI adopts light Bootstrap 5 primitives consistently (`.container`,
`.row/.col-*`, `.card`, `.table`, `.form-select`, `.form-control`, `.btn*`,
`.badge`, `.alert`, `.modal`). Modals/dropdowns are driven by React state, not
Bootstrap JS, to avoid a second UI-state source and keep the bundle light.

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
