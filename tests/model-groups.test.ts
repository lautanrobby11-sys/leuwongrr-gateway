import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayDatabase } from '../src/persistence/database.js';
import { ModelGroupCatalog } from '../src/models/groups.js';
import { testConfig } from './support/harness.js';

let root: string | null = null;

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
});

function open(): GatewayDatabase {
  root = mkdtempSync(join(tmpdir(), 'lwrr-groups-'));
  return new GatewayDatabase(join(root, 'gateway.db'), testConfig.API_KEY_PEPPER, {
    cacheKib: testConfig.SQLITE_CACHE_KIB
  });
}

describe('model group catalog', () => {
  it('assigns one model to one group and moving it replaces membership', () => {
    const db = open();
    const groups = new ModelGroupCatalog(db.db);
    groups.create({ id: 'value', name: 'Value', multiplierBps: 12500, enabled: true });
    groups.create({ id: 'frontier', name: 'Frontier', multiplierBps: 15000, enabled: true });

    db.db.prepare('UPDATE models SET group_id = ? WHERE public_id = ?').run('legacy-default', 'lwrr-text');
    groups.assignModel('value', 'lwrr-text');
    expect(db.db.prepare('SELECT group_id FROM models WHERE public_id = ?').get('lwrr-text')).toEqual({ group_id: 'value' });
    groups.assignModel('frontier', 'lwrr-text');
    expect(db.db.prepare('SELECT group_id FROM models WHERE public_id = ?').get('lwrr-text')).toEqual({ group_id: 'frontier' });
    db.close();
  });

  it('refuses deleting a group referenced by a plan', () => {
    const db = open();
    const groups = new ModelGroupCatalog(db.db);
    groups.create({ id: 'value', name: 'Value', multiplierBps: 12500, enabled: true });
    db.db.prepare(`INSERT INTO plans (id, name, monthly_price_cents, included_tokens, overage_cents_per_million, max_concurrent, rate_limit_rpm, daily_budget_units, models_json, active, updated_at, model_group_id) VALUES ('plan-a', 'Plan A', 0, 0, 0, 1, 1, 1, '[]', 1, datetime('now'), 'value')`).run();
    expect(() => groups.remove('value')).toThrowError('group_in_use');
    db.close();
  });

  it('refuses deleting a group that still owns models', () => {
    const db = open();
    const groups = new ModelGroupCatalog(db.db);
    groups.create({ id: 'value', name: 'Value', multiplierBps: 12500, enabled: true });
    db.db.prepare("UPDATE models SET group_id = 'value' WHERE public_id = 'lwrr-text'").run();
    expect(() => groups.remove('value')).toThrowError('group_has_models');
    expect(db.db.prepare("SELECT group_id FROM models WHERE public_id = 'lwrr-text'").get()).toEqual({ group_id: 'value' });
    db.close();
  });

  it('refuses deleting a group referenced only by a subscription snapshot', () => {
    const db = open();
    const groups = new ModelGroupCatalog(db.db);
    groups.create({ id: 'value', name: 'Value', multiplierBps: 12500, enabled: true });
    db.tenants.upsertTenant('tenant-a', 'Tenant A');
    db.db.prepare(`INSERT INTO plans (id, name, monthly_price_cents, included_tokens, overage_cents_per_million, max_concurrent, rate_limit_rpm, daily_budget_units, models_json, active, updated_at, model_group_id) VALUES ('plan-a', 'Plan A', 0, 0, 0, 1, 1, 1, '[]', 1, datetime('now'), NULL)`).run();
    db.db.prepare(`INSERT INTO accounts (id, tenant_id, email, display_name, role, status, created_at) VALUES ('account-a', 'tenant-a', 'a@example.test', 'A', 'member', 'active', datetime('now'))`).run();
    db.db.prepare(`INSERT INTO subscriptions (id, account_id, plan_id, status, period_start, period_end, included_tokens, used_tokens, auto_renew, created_at, updated_at, model_group_id) VALUES ('sub-a', 'account-a', 'plan-a', 'active', datetime('now'), datetime('now', '+1 day'), 0, 0, 1, datetime('now'), datetime('now'), 'value')`).run();
    expect(() => groups.remove('value')).toThrowError('group_in_use');
    db.close();
  });

  it('preserves disabled state when updating without enabled', () => {
    const db = open();
    const groups = new ModelGroupCatalog(db.db);
    groups.create({ id: 'value', name: 'Value', multiplierBps: 12500, enabled: false });
    const updated = groups.update('value', { name: 'Value+', multiplierBps: 13000 });
    expect(updated.enabled).toBe(false);
    db.close();
  });
});
