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
});
