import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/persistence/migrations.js';
import { createTempDatabase } from './support/harness.js';

describe('migration 0016_account_passwords', () => {
  it('backfills pre-existing accounts as verified when applied to an old schema', () => {
    // Build a database at the pre-0016 shape: run every migration except the
    // last one, insert an account, then apply 0016 and check the backfill.
    const db = new Database(':memory:');
    try {
      const prior = MIGRATIONS.filter((migration) => migration.id !== '0016_account_passwords');
      for (const migration of prior) {
        db.exec(migration.sql);
        migration.run?.(db);
      }
      db.prepare(
        "INSERT INTO tenants (id, name, created_at) VALUES ('t1', 'T', datetime('now'))"
      ).run();
      db.prepare(
        "INSERT INTO accounts (id, tenant_id, email, display_name, role, status, created_at) VALUES ('a1', 't1', 'legacy@example.test', 'Legacy', 'member', 'active', datetime('now'))"
      ).run();

      const target = MIGRATIONS.find((migration) => migration.id === '0016_account_passwords');
      expect(target).toBeTruthy();
      db.exec(target!.sql);

      const row = db
        .prepare('SELECT password_hash, email_verified_at FROM accounts WHERE id = ?')
        .get('a1') as { password_hash: string | null; email_verified_at: string | null };
      expect(row.password_hash).toBeNull();
      expect(row.email_verified_at).not.toBeNull();
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('adds the purpose column to login_codes on a fresh database', () => {
    const { db, dispose } = createTempDatabase();
    try {
      const info = db.db.prepare('PRAGMA table_info(login_codes)').all() as Array<{ name: string }>;
      expect(info.some((col) => col.name === 'purpose')).toBe(true);
      const accountCols = db.db.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>;
      expect(accountCols.some((col) => col.name === 'password_hash')).toBe(true);
      expect(accountCols.some((col) => col.name === 'email_verified_at')).toBe(true);
    } finally {
      dispose();
    }
  });
});
