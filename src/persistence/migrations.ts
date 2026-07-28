export interface Migration { id:string; sql:string }
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
}];
