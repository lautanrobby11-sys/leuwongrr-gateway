import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayDatabase } from '../src/persistence/database.js';
import { runModelGroupBackfill } from '../src/persistence/migrations.js';
import { testConfig } from './support/harness.js';

const MIGRATION_ID = '0010_model_groups';
let root: string | null = null;

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
});

function openDatabase(): GatewayDatabase {
  if (!root) root = mkdtempSync(join(tmpdir(), 'lwrr-mig-0010-'));
  return new GatewayDatabase(join(root, 'gateway.db'), testConfig.API_KEY_PEPPER, {
    cacheKib: testConfig.SQLITE_CACHE_KIB
  });
}

function dropMigration(db: GatewayDatabase): void {
  db.db.prepare('DELETE FROM schema_migrations WHERE id = ?').run(MIGRATION_ID);
}

function seedModel(db: GatewayDatabase, id: string): void {
  db.db.prepare(
    `INSERT INTO models (
      id, public_id, display_name, provider, multimodal,
      input_price_per_m, output_price_per_m, cache_read_price_per_m,
      cache_write_price_per_m, enabled, input_price_cents,
      output_price_cents, cache_read_price_cents, upstream_model,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'other', 0, 0, 0, 0, 0, 1, 10, 20, 3, 'auto', ?, ?)`
  ).run(id, id, id, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
}

describe('migration 0010 model groups', () => {
  it('rejects a legacy plan whose membership would expand into the group', () => {
    const first = openDatabase();
    first.db.prepare("DELETE FROM models WHERE public_id = 'lwrr-text'").run();
    seedModel(first, 'model-a');
    seedModel(first, 'model-b');
    first.db.prepare(
      `INSERT INTO plans (
        id, name, monthly_price_cents, included_tokens,
        overage_cents_per_million, max_concurrent, rate_limit_rpm,
        daily_budget_units, models_json, active, updated_at
      ) VALUES ('plan-a', 'Plan A', 0, 100, 10, 1, 10, 100, ?, 1, ?)`
    ).run(JSON.stringify(['model-a']), '2026-01-01T00:00:00Z');
    dropMigration(first);
    expect(() => runModelGroupBackfill(first.db as never)).toThrow(/legacy.*membership|entitlement/i);
    first.close();
    root = null;
  });

  it('backfills a single legacy group only when every plan entitlement is preserved', () => {
    const first = openDatabase();
    first.db.prepare("DELETE FROM models WHERE public_id = 'lwrr-text'").run();
    seedModel(first, 'model-a');
    first.db.prepare(
      `INSERT INTO plans (
        id, name, monthly_price_cents, included_tokens,
        overage_cents_per_million, max_concurrent, rate_limit_rpm,
        daily_budget_units, models_json, active, updated_at
      ) VALUES ('plan-a', 'Plan A', 0, 100, 10, 1, 10, 100, ?, 1, ?)`
    ).run(JSON.stringify(['model-a']), '2026-01-01T00:00:00Z');
    dropMigration(first);
    runModelGroupBackfill(first.db as never);
    const group = first.db.prepare('SELECT id, multiplier_bps, enabled FROM model_groups').get() as {
      id: string;
      multiplier_bps: number;
      enabled: number;
    };
    expect(group).toEqual({ id: 'legacy-default', multiplier_bps: 10000, enabled: 1 });
    expect(first.db.prepare('SELECT group_id FROM models WHERE public_id = ?').get('model-a')).toEqual({
      group_id: 'legacy-default'
    });
    expect(first.db.prepare('SELECT model_group_id FROM plans WHERE id = ?').get('plan-a')).toEqual({
      model_group_id: 'legacy-default'
    });
    first.close();
    root = null;
  });
});
