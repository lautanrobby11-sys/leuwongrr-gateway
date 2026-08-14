import type Database from 'better-sqlite3';

export interface Migration { id:string; sql:string; run?: (db: Database.Database) => void }
export const MIGRATIONS: readonly Migration[] = [{
  id: '0001_gateway_core',
  sql: `
CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE api_keys (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), key_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, last4 TEXT NOT NULL, scopes_json TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX api_keys_tenant_idx ON api_keys(tenant_id);
CREATE TABLE model_policies (tenant_id TEXT NOT NULL REFERENCES tenants(id), model_id TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), PRIMARY KEY(tenant_id,model_id));
CREATE TABLE usage_events (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), request_id TEXT NOT NULL, units INTEGER NOT NULL CHECK(units >= 0), state TEXT NOT NULL CHECK(state IN ('reserved','settled','released')), day TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX usage_events_tenant_day_idx ON usage_events(tenant_id,day);
CREATE TABLE idempotency_keys (tenant_id TEXT NOT NULL REFERENCES tenants(id), key TEXT NOT NULL, request_hash TEXT NOT NULL, status_code INTEGER, response_json TEXT, expires_at TEXT NOT NULL, PRIMARY KEY(tenant_id,key));
CREATE TABLE audit_logs (id TEXT PRIMARY KEY, tenant_id TEXT, actor_type TEXT NOT NULL, event TEXT NOT NULL, trace_id TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL);
`
}, {
  id: '0002_api_key_lifecycle',
  sql: `
ALTER TABLE api_keys ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE api_keys ADD COLUMN mode TEXT NOT NULL DEFAULT 'live';
ALTER TABLE api_keys ADD COLUMN expires_at TEXT;
ALTER TABLE api_keys ADD COLUMN last_used_at TEXT;
ALTER TABLE api_keys ADD COLUMN rotated_from TEXT;
CREATE INDEX api_keys_active_idx ON api_keys(tenant_id, revoked_at);
CREATE TABLE tenant_limits (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  daily_budget_units INTEGER NOT NULL CHECK(daily_budget_units >= 0),
  max_concurrent INTEGER NOT NULL CHECK(max_concurrent > 0),
  rate_limit_rpm INTEGER NOT NULL CHECK(rate_limit_rpm > 0),
  updated_at TEXT NOT NULL
);
`
}, {
  id: '0003_accounts_and_billing',
  sql: `
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK(role IN ('member','support','operator','admin','owner')) DEFAULT 'member',
  status TEXT NOT NULL CHECK(status IN ('active','suspended')) DEFAULT 'active',
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE INDEX accounts_tenant_idx ON accounts(tenant_id);
CREATE TABLE account_identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL CHECK(provider IN ('email','google','discord','telegram')),
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(provider, subject)
);
CREATE TABLE login_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX login_codes_email_idx ON login_codes(email, created_at);
CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  verifier TEXT NOT NULL,
  redirect_path TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  token_hash TEXT NOT NULL UNIQUE,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX sessions_account_idx ON sessions(account_id);
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  monthly_price_cents INTEGER NOT NULL CHECK(monthly_price_cents >= 0),
  included_tokens INTEGER NOT NULL CHECK(included_tokens >= 0),
  overage_cents_per_million INTEGER NOT NULL CHECK(overage_cents_per_million >= 0),
  max_concurrent INTEGER NOT NULL CHECK(max_concurrent > 0),
  rate_limit_rpm INTEGER NOT NULL CHECK(rate_limit_rpm > 0),
  daily_budget_units INTEGER NOT NULL CHECK(daily_budget_units >= 0),
  models_json TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL CHECK(active IN (0,1)) DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  plan_id TEXT NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL CHECK(status IN ('active','past_due','canceled')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  included_tokens INTEGER NOT NULL CHECK(included_tokens >= 0),
  used_tokens INTEGER NOT NULL DEFAULT 0 CHECK(used_tokens >= 0),
  auto_renew INTEGER NOT NULL CHECK(auto_renew IN (0,1)) DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX subscriptions_account_idx ON subscriptions(account_id, status);
CREATE TABLE wallets (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  balance_tokens INTEGER NOT NULL DEFAULT 0 CHECK(balance_tokens >= 0),
  updated_at TEXT NOT NULL
);
CREATE TABLE ledger_entries (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK(kind IN ('grant','purchase','debit','refund','adjustment')),
  source TEXT NOT NULL CHECK(source IN ('subscription','payg','admin','payment','usage')),
  tokens INTEGER NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  balance_after INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(account_id, source, reference)
);
CREATE INDEX ledger_account_idx ON ledger_entries(account_id, created_at);
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL DEFAULT 'cryptomus',
  order_id TEXT NOT NULL UNIQUE,
  invoice_uuid TEXT,
  purpose TEXT NOT NULL CHECK(purpose IN ('subscription','topup')),
  plan_id TEXT,
  tokens INTEGER NOT NULL DEFAULT 0 CHECK(tokens >= 0),
  amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL,
  payment_url TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT
);
CREATE INDEX payments_account_idx ON payments(account_id, created_at);
CREATE TABLE payment_events (
  id TEXT PRIMARY KEY,
  payment_id TEXT,
  digest TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE billing_cursors (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  last_usage_at TEXT NOT NULL
);
`
}, {
  id: '0004_tenant_limits_backfill',
  sql: `
-- Issue #47: existing tenants created before the explicit-tenant_limits rule
-- have no row and silently fall back to the 100000-unit global default.
-- Backfill a conservative row for every tenant still missing one. Forward-only
-- and idempotent: the NOT IN predicate never overwrites an existing row.
INSERT INTO tenant_limits(tenant_id, daily_budget_units, max_concurrent, rate_limit_rpm, updated_at)
SELECT id, 1000, 2, 60, datetime('now')
FROM tenants WHERE id NOT IN (SELECT tenant_id FROM tenant_limits);
`
}, {
  id: '0005_exchange_rates',
  sql: `
CREATE TABLE exchange_rates (
  id TEXT PRIMARY KEY DEFAULT 'default',
  idr_per_usd INTEGER NOT NULL CHECK(idr_per_usd > 0),
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES accounts(id),
  CONSTRAINT singleton CHECK(id = 'default')
);
`
}, {
  id: '0006_models',
  sql: `
CREATE TABLE models (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('openai','anthropic','google','meta','other')),
  multimodal INTEGER NOT NULL DEFAULT 0 CHECK(multimodal IN (0,1)),
  input_price_per_m REAL NOT NULL CHECK(input_price_per_m >= 0),
  output_price_per_m REAL NOT NULL CHECK(output_price_per_m >= 0),
  cache_read_price_per_m REAL NOT NULL CHECK(cache_read_price_per_m >= 0),
  cache_write_price_per_m REAL NOT NULL CHECK(cache_write_price_per_m >= 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`
}, {
  // Release 2 subscription engine (spec section 20.1): plans carry the
  // purchase method, price, duration and reset policy; subscriptions snapshot
  // the plan so an admin editing a plan never rewrites a live subscription.
  id: '0007_subscription_engine',
  sql: `
ALTER TABLE plans ADD COLUMN price_cents INTEGER NOT NULL DEFAULT 0 CHECK(price_cents >= 0);
ALTER TABLE plans ADD COLUMN duration_hours INTEGER CHECK(duration_hours IS NULL OR duration_hours > 0);
ALTER TABLE plans ADD COLUMN timer_basis TEXT CHECK(timer_basis IN ('from_payment', 'from_first_use')) DEFAULT 'from_payment';
ALTER TABLE plans ADD COLUMN resets_allowed INTEGER NOT NULL DEFAULT 0 CHECK(resets_allowed >= 0);
ALTER TABLE plans ADD COLUMN method TEXT NOT NULL CHECK(method IN ('rolling_time', 'token_pack')) DEFAULT 'token_pack';
ALTER TABLE plans ADD COLUMN tier_label TEXT NOT NULL DEFAULT '';
ALTER TABLE subscriptions ADD COLUMN method TEXT CHECK(method IN ('rolling_time', 'token_pack'));
ALTER TABLE subscriptions ADD COLUMN duration_hours INTEGER;
ALTER TABLE subscriptions ADD COLUMN timer_basis TEXT CHECK(timer_basis IN ('from_payment', 'from_first_use'));
ALTER TABLE subscriptions ADD COLUMN activated_at TEXT;
ALTER TABLE subscriptions ADD COLUMN expires_at TEXT;
ALTER TABLE subscriptions ADD COLUMN resets_remaining INTEGER NOT NULL DEFAULT 0 CHECK(resets_remaining >= 0);
`
}, {
  // Release 2a model catalog (Boss spec): admins register models manually from
  // OmniRoute. The existing 0006 table already carries identity, provider,
  // multimodal and per-million dollar prices; this migration adds the cents
  // pricing columns the admin CRUD writes and the upstream model name the
  // gateway needs to route the model through OmniRoute.
  id: '0008_model_catalog',
  sql: `
ALTER TABLE models ADD COLUMN input_price_cents INTEGER NOT NULL DEFAULT 0 CHECK(input_price_cents >= 0);
ALTER TABLE models ADD COLUMN output_price_cents INTEGER NOT NULL DEFAULT 0 CHECK(output_price_cents >= 0);
ALTER TABLE models ADD COLUMN cache_read_price_cents INTEGER NOT NULL DEFAULT 0 CHECK(cache_read_price_cents >= 0);
ALTER TABLE models ADD COLUMN upstream_model TEXT NOT NULL DEFAULT 'auto';
`
}, {
  // Goku decision (Notion 20.9): a historical orphan in exchange_rates.updated_by
  // references an account that no longer exists, which fails PRAGMA
  // foreign_key_check and blocks the backup/restore drill. The column is
  // nullable with NO ACTION semantics, so this clears only orphan references,
  // never touches valid rows, and never deletes the exchange_rates row itself.
  // Idempotent: after the first run no orphan remains and the UPDATE matches
  // nothing.
  id: '0009_clear_orphan_exchange_rate_updated_by',
  sql: `
UPDATE exchange_rates SET updated_by = NULL
WHERE updated_by IS NOT NULL
  AND updated_by NOT IN (SELECT id FROM accounts);
`
}, {
  id: '0010_model_groups',
  sql: `
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
`,
  run: runModelGroupBackfill
}, {
  id: '0011_subscription_group_snapshot',
  sql: `
ALTER TABLE subscriptions ADD COLUMN model_group_id TEXT REFERENCES model_groups(id);
ALTER TABLE subscriptions ADD COLUMN balance_cents INTEGER NOT NULL DEFAULT 0 CHECK(balance_cents >= 0);
ALTER TABLE wallets ADD COLUMN balance_cents INTEGER NOT NULL DEFAULT 0 CHECK(balance_cents >= 0);
CREATE INDEX subscriptions_group_idx ON subscriptions(model_group_id);
`,
  run: (db) => {
    db.prepare(`UPDATE subscriptions SET model_group_id = (
      SELECT model_group_id FROM plans WHERE plans.id = subscriptions.plan_id
    ) WHERE model_group_id IS NULL`).run();
  }
}];

export function runModelGroupBackfill(db: Database.Database): void {
    type PlanRow = { id: string; models_json: string; active: number };
    const plans = db.prepare('SELECT id, models_json, active FROM plans ORDER BY id').all() as PlanRow[];
    const modelIds = new Set(
      (db.prepare('SELECT public_id FROM models').all() as Array<{ public_id: string }>).map((row) => row.public_id)
    );
    const memberships = plans.map((plan) => {
      let parsed: unknown;
      try { parsed = JSON.parse(plan.models_json); } catch { throw new Error('legacy_membership_invalid'); }
      if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== 'string' || id.trim() === '')) {
        throw new Error('legacy_membership_invalid');
      }
      const ids = [...new Set(parsed.map((id) => id.trim()))];
      if (ids.some((id) => !modelIds.has(id))) throw new Error('legacy_membership_model_missing');
      if (plan.active === 1 && ids.length === 0) throw new Error('legacy_membership_ambiguous');
      return { plan, ids };
    });
    const activeSets = memberships.filter(({ plan }) => plan.active === 1).map(({ ids }) => ids);
    if (modelIds.size > 1 && activeSets.some((ids) => ids.length !== modelIds.size || ids.some((id) => !modelIds.has(id)))) {
      throw new Error('legacy_membership_ambiguous');
    }
    db.prepare(`
      INSERT INTO model_groups (id, name, multiplier_bps, enabled, created_at, updated_at)
      VALUES ('legacy-default', 'Legacy Default', 10000, 1, datetime('now'), datetime('now'))
      ON CONFLICT(id) DO NOTHING
    `).run();
    db.prepare("UPDATE models SET group_id = 'legacy-default' WHERE group_id IS NULL").run();
    db.prepare("UPDATE plans SET model_group_id = 'legacy-default' WHERE model_group_id IS NULL").run();
    const modelCount = (db.prepare('SELECT COUNT(*) AS count FROM models').get() as { count: number }).count;
    if (modelCount === 0) {
      db.prepare(`
        INSERT INTO models (
          id, public_id, display_name, provider, multimodal,
          input_price_per_m, output_price_per_m, cache_read_price_per_m,
          cache_write_price_per_m, enabled, input_price_cents,
          output_price_cents, cache_read_price_cents, upstream_model,
          group_id, capabilities_json, max_output_tokens, created_at, updated_at
        ) VALUES ('legacy-lwrr-text', 'lwrr-text', 'LeuwongRR Text', 'other', 0,
          0, 0, 0, 0, 1, 0, 0, 0, 'auto', 'legacy-default',
          '["text","stream"]', 4096, datetime('now'), datetime('now'))
        ON CONFLICT(public_id) DO NOTHING
      `).run();
    }
}
