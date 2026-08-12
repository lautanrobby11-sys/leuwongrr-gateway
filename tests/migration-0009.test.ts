import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayDatabase } from '../src/persistence/database.js';
import { testConfig } from './support/harness.js';

const MIGRATION_ID = '0009_clear_orphan_exchange_rate_updated_by';

let root: string | null = null;

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
});

function openDatabase(): GatewayDatabase {
  if (!root) root = mkdtempSync(join(tmpdir(), 'lwrr-mig-'));
  return new GatewayDatabase(join(root, 'gateway.db'), testConfig.API_KEY_PEPPER, {
    cacheKib: testConfig.SQLITE_CACHE_KIB
  });
}

function seedTenantRow(db: GatewayDatabase): void {
  db.db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').run(
    'tenant-1',
    'tenant-1',
    '2026-01-01T00:00:00Z'
  );
}

function seedAccountRow(db: GatewayDatabase, id: string): void {
  db.db.prepare(
    'INSERT INTO accounts (id, tenant_id, email, display_name, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, 'tenant-1', `${id}@example.test`, id, 'admin', 'active', '2026-01-01T00:00:00Z');
}

function seedExchangeRate(db: GatewayDatabase, updatedBy: string | null): void {
  // The orphan case must be insertable even though foreign_keys is ON, exactly
  // like the historical production row that predates the account it names.
  db.db.pragma('foreign_keys = OFF');
  db.db.prepare('INSERT INTO exchange_rates (id, idr_per_usd, updated_at, updated_by) VALUES (?, ?, ?, ?)').run(
    'default',
    16000,
    '2026-08-11 16:31:02',
    updatedBy
  );
  db.db.pragma('foreign_keys = ON');
}

function dropMigrationRecord(db: GatewayDatabase): void {
  db.db.prepare('DELETE FROM schema_migrations WHERE id = ?').run(MIGRATION_ID);
}

describe('migration 0009 clear orphan exchange_rates.updated_by', () => {
  it('clears an orphan updated_by, records 0009, and leaves foreign_key_check empty', () => {
    // Phase 1: simulate the historical pre-0009 database. The runner already
    // applied 0009, so drop its record and seed an orphan row that references
    // an account that does not exist.
    const first = openDatabase();
    dropMigrationRecord(first);
    seedTenantRow(first);
    seedExchangeRate(first, 'admin');
    first.close();

    // Phase 2: reopen the same file; the app migration runner applies 0009
    // inside its transaction.
    const second = openDatabase();
    const row = second.db.prepare('SELECT updated_by FROM exchange_rates WHERE id = ?').get('default') as {
      updated_by: string | null;
    };
    expect(row.updated_by).toBeNull();
    expect(second.db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(MIGRATION_ID)).toBeTruthy();
    expect(second.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    second.close();
  });

  it('leaves a valid updated_by unchanged and is idempotent', () => {
    const first = openDatabase();
    dropMigrationRecord(first);
    seedTenantRow(first);
    seedAccountRow(first, 'acc-1');
    seedExchangeRate(first, 'acc-1');
    first.close();

    const second = openDatabase();
    const row = second.db.prepare('SELECT updated_by FROM exchange_rates WHERE id = ?').get('default') as {
      updated_by: string | null;
    };
    expect(row.updated_by).toBe('acc-1');
    expect(second.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    second.close();

    // Idempotent: a further reopen applies nothing and changes nothing.
    const third = openDatabase();
    const again = third.db.prepare('SELECT updated_by FROM exchange_rates WHERE id = ?').get('default') as {
      updated_by: string | null;
    };
    expect(again.updated_by).toBe('acc-1');
    third.close();
  });
});