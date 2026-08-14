import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayDatabase } from '../src/persistence/database.js';
import { resolveCatalogModel, ModelResolutionError } from '../src/policy/model-resolver.js';
import { testConfig } from './support/harness.js';

let root: string | null = null;
afterEach(() => { if (root) { rmSync(root, { recursive: true, force: true }); root = null; } });
function open(): GatewayDatabase {
  root = mkdtempSync(join(tmpdir(), 'lwrr-resolver-'));
  return new GatewayDatabase(join(root, 'gateway.db'), testConfig.API_KEY_PEPPER, { cacheKib: testConfig.SQLITE_CACHE_KIB });
}

describe('database model resolver', () => {
  it('resolves an enabled entitled model from its subscription group', () => {
    const db = open();
    db.tenants.upsertTenant('tenant-1', 'Tenant');
    db.db.prepare("INSERT INTO accounts (id, tenant_id, email, display_name, role, status, created_at) VALUES ('account-1', 'tenant-1', 'a@example.test', 'A', 'member', 'active', datetime('now'))").run();
    db.db.prepare("INSERT INTO model_groups (id, name, multiplier_bps, enabled, created_at, updated_at) VALUES ('value', 'Value', 12500, 1, datetime('now'), datetime('now'))").run();
    db.db.prepare("UPDATE models SET group_id = 'value' WHERE public_id = 'lwrr-text'").run();
    db.db.prepare("UPDATE plans SET model_group_id = 'value' WHERE id = 'missing'").run();
    db.db.prepare("INSERT INTO plans (id, name, monthly_price_cents, included_tokens, overage_cents_per_million, max_concurrent, rate_limit_rpm, daily_budget_units, models_json, active, updated_at, model_group_id) VALUES ('plan-1', 'Plan', 0, 100, 1, 1, 1, 1, '[]', 1, datetime('now'), 'value')").run();
    db.db.prepare("INSERT INTO subscriptions (id, account_id, plan_id, status, period_start, period_end, included_tokens, used_tokens, auto_renew, created_at, updated_at) VALUES ('sub-1', 'account-1', 'plan-1', 'active', datetime('now'), datetime('now', '+1 day'), 100, 0, 1, datetime('now'), datetime('now'))").run();
    expect(resolveCatalogModel(db.db, 'lwrr-text', [], 'tenant-1', 'account-1').upstreamModel).toBe('auto');
    db.close();
  });

  it('denies an explicit tenant policy but allows absent policy', () => {
    const db = open();
    db.tenants.upsertTenant('tenant-1', 'Tenant');
    db.db.prepare("INSERT INTO accounts (id, tenant_id, email, display_name, role, status, created_at) VALUES ('account-1', 'tenant-1', 'a@example.test', 'A', 'member', 'active', datetime('now'))").run();
    db.db.prepare("INSERT INTO model_groups (id, name, multiplier_bps, enabled, created_at, updated_at) VALUES ('value', 'Value', 12500, 1, datetime('now'), datetime('now'))").run();
    db.db.prepare("UPDATE models SET group_id = 'value' WHERE public_id = 'lwrr-text'").run();
    db.db.prepare("INSERT INTO plans (id, name, monthly_price_cents, included_tokens, overage_cents_per_million, max_concurrent, rate_limit_rpm, daily_budget_units, models_json, active, updated_at, model_group_id) VALUES ('plan-1', 'Plan', 0, 100, 1, 1, 1, 1, '[]', 1, datetime('now'), 'value')").run();
    db.db.prepare("INSERT INTO subscriptions (id, account_id, plan_id, status, period_start, period_end, included_tokens, used_tokens, auto_renew, created_at, updated_at) VALUES ('sub-1', 'account-1', 'plan-1', 'active', datetime('now'), datetime('now', '+1 day'), 100, 0, 1, datetime('now'), datetime('now'))").run();
    expect(resolveCatalogModel(db.db, 'lwrr-text', [], 'tenant-1', 'account-1').id).toBe('lwrr-text');
    db.tenants.setModelPolicy('tenant-1', 'lwrr-text', false);
    expect(() => resolveCatalogModel(db.db, 'lwrr-text', [], 'tenant-1', 'account-1')).toThrowError(new ModelResolutionError('model_not_entitled', 403));
    db.close();
  });
});
