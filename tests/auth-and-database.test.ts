import { afterEach, describe, expect, it } from 'vitest';
import { bearerToken, requireScope, AuthError } from '../src/auth/api-keys.js';
import { createTempDatabase, seedTenant } from './support/harness.js';
import type { GatewayDatabase } from '../src/persistence/database.js';

let dispose: (() => void) | null = null;

function openDatabase(): GatewayDatabase {
  const created = createTempDatabase();
  dispose = created.dispose;
  return created.db;
}

afterEach(() => {
  if (dispose) {
    dispose();
    dispose = null;
  }
});

describe('API key lifecycle', () => {
  it('stores only a hash and resolves tenant scopes', () => {
    const db = openDatabase();
    const token = seedTenant(db, 'tenant-a', ['models:read']);
    const record = db.authenticate(token);
    expect(record).not.toBeNull();
    if (!record) throw new Error('expected authenticated record');
    expect(record.tenantId).toBe('tenant-a');
    expect(JSON.stringify(db.db.prepare('SELECT * FROM api_keys').all())).not.toContain(token);
    requireScope(record, 'models:read');
    expect(() => requireScope(record, 'chat:write')).toThrow(AuthError);
  });

  it('rejects unknown and malformed credentials', () => {
    const db = openDatabase();
    seedTenant(db, 'tenant-a', ['models:read']);
    // Construct a credential-shaped unknown key at runtime so repository secret
    // scanning never needs to allowlist a token-like literal.
    const unknownKey = ['lwrr', 'live', 'x'.repeat(43)].join('_');
    expect(db.authenticate(unknownKey)).toBeNull();
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('Bearer not-a-key')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe('tenant budget isolation', () => {
  it('scopes reservations and settlement per tenant', () => {
    const db = openDatabase();
    seedTenant(db, 'tenant-a', ['chat:write']);
    seedTenant(db, 'tenant-b', ['chat:write']);
    const reservation = db.reserveBudget('tenant-a', 'r1', 60, 100);
    expect(() => db.reserveBudget('tenant-a', 'r2', 50, 100)).toThrow('daily_budget_exceeded');
    expect(() => db.reserveBudget('tenant-b', 'r3', 50, 100)).not.toThrow();
    db.settleBudget(reservation, 'tenant-b', 1);
    expect(db.db.prepare('SELECT units,state FROM usage_events WHERE id=?').get(reservation)).toEqual({
      units: 60,
      state: 'reserved'
    });
    db.settleBudget(reservation, 'tenant-a', 42);
    expect(db.db.prepare('SELECT units,state FROM usage_events WHERE id=?').get(reservation)).toEqual({
      units: 42,
      state: 'settled'
    });
  });
});
