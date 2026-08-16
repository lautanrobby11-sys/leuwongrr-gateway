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

  it('persists the phase-B per-request detail on settlement', () => {
    const db = openDatabase();
    seedTenant(db, 'tenant-a', ['chat:write']);
    const reservation = db.reserveBudget('tenant-a', 'r1', 100, 10_000);
    db.settleBudget(reservation, 'tenant-a', 88, 10_000, {
      modelId: 'lwrr-text',
      inputTokens: 60,
      outputTokens: 28,
      cachedTokens: 20,
      thinkingTokens: 5,
      durationMs: 1234,
      finishReason: 'stop',
      userAgent: 'ZCode/1.4',
      appLabel: 'zcode'
    });
    expect(
      db.db
        .prepare(
          'SELECT model_id, input_tokens, output_tokens, cached_tokens, thinking_tokens, duration_ms, finish_reason, user_agent, app_label FROM usage_events WHERE id=?'
        )
        .get(reservation)
    ).toEqual({
      model_id: 'lwrr-text',
      input_tokens: 60,
      output_tokens: 28,
      cached_tokens: 20,
      thinking_tokens: 5,
      duration_ms: 1234,
      finish_reason: 'stop',
      user_agent: 'ZCode/1.4',
      app_label: 'zcode'
    });
  });

  it('leaves every detail column null when settled without detail', () => {
    const db = openDatabase();
    seedTenant(db, 'tenant-a', ['chat:write']);
    const reservation = db.reserveBudget('tenant-a', 'r1', 10, 10_000);
    db.settleBudget(reservation, 'tenant-a', 10);
    expect(
      db.db
        .prepare(
          'SELECT model_id, input_tokens, output_tokens, cached_tokens, thinking_tokens, duration_ms, finish_reason, user_agent, app_label FROM usage_events WHERE id=?'
        )
        .get(reservation)
    ).toEqual({
      model_id: null,
      input_tokens: null,
      output_tokens: null,
      cached_tokens: null,
      thinking_tokens: null,
      duration_ms: null,
      finish_reason: null,
      user_agent: null,
      app_label: null
    });
  });
});
