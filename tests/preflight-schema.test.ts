import { afterEach, describe, expect, it } from 'vitest';
import { verifyDatabasePreflight } from '../src/persistence/preflight-check.js';
import { createTempDatabase } from './support/harness.js';
import type { GatewayDatabase } from '../src/persistence/database.js';

let dispose: (() => void) | null = null;

afterEach(() => {
  if (dispose) dispose();
  dispose = null;
});

function openDatabase(): GatewayDatabase {
  const created = createTempDatabase();
  dispose = created.dispose;
  return created.db;
}

describe('database preflight schema', () => {
  it('accepts the exact migration set', () => {
    expect(() => verifyDatabasePreflight(openDatabase())).not.toThrow();
  });

  it('refuses a database missing an expected migration record', () => {
    const database = openDatabase();
    database.db.prepare('DELETE FROM schema_migrations WHERE id=?').run('0004_tenant_limits_backfill');
    expect(() => verifyDatabasePreflight(database)).toThrow('database_schema_mismatch');
  });

  it('refuses a database that is newer than the release', () => {
    const database = openDatabase();
    database.db
      .prepare('INSERT INTO schema_migrations(id,applied_at) VALUES(?,?)')
      .run('9999_future_migration', new Date().toISOString());
    expect(() => verifyDatabasePreflight(database)).toThrow('database_schema_mismatch');
  });
});
