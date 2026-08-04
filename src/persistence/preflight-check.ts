import type { GatewayDatabase } from './database.js';
import { MIGRATIONS } from './migrations.js';

export function verifyDatabasePreflight(db: GatewayDatabase): void {
  const integrity = db.db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  if (integrity[0]?.integrity_check !== 'ok') throw new Error('database_integrity_failed');

  const expected = MIGRATIONS.map((migration) => migration.id).sort();
  const applied = (
    db.db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>
  ).map((row) => row.id);
  if (JSON.stringify(applied) !== JSON.stringify(expected)) {
    throw new Error('database_schema_mismatch');
  }
}
