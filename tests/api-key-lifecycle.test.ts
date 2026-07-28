import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayDatabase } from '../src/persistence/database.js';
import { TenantStoreError } from '../src/persistence/tenant-store.js';
import { AuthError, requireScope } from '../src/auth/api-keys.js';

const PEPPER = 'p'.repeat(48);

let root: string;
let db: GatewayDatabase;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lwrr-keys-'));
  db = new GatewayDatabase(join(root, 'gateway.db'), PEPPER);
  db.tenants.upsertTenant('acme', 'Acme');
  db.tenants.upsertTenant('globex', 'Globex');
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('api key issuance', () => {
  it('issues a credential the gateway can verify', () => {
    const issued = db.tenants.issue({ tenantId: 'acme', name: 'primary', scopes: ['models:read'] });
    const record = db.authenticate(issued.plaintext);
    expect(record?.tenantId).toBe('acme');
    expect(record?.name).toBe('primary');
    expect(record?.scopes.has('models:read')).toBe(true);
  });

  it('records issuance metadata without exposing the secret', () => {
    const issued = db.tenants.issue({ tenantId: 'acme', name: 'primary', scopes: ['models:read'] });
    const listed = db.tenants.list('acme');
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(issued.plaintext);
    expect(listed[0].last4).toBe(issued.key.last4);
  });

  it('separates live and test credentials by prefix', () => {
    const live = db.tenants.issue({ tenantId: 'acme', name: 'l', scopes: ['models:read'] });
    const test = db.tenants.issue({
      tenantId: 'acme',
      name: 't',
      scopes: ['models:read'],
      mode: 'test'
    });
    expect(live.key.mode).toBe('live');
    expect(test.key.mode).toBe('test');
    expect(test.plaintext.startsWith(test.key.prefix)).toBe(true);
    expect(db.authenticate(test.plaintext)?.mode).toBe('test');
  });

  it('refuses unknown tenants and empty scope sets', () => {
    expect(() =>
      db.tenants.issue({ tenantId: 'nobody', name: 'x', scopes: ['models:read'] })
    ).toThrow(TenantStoreError);
    expect(() => db.tenants.issue({ tenantId: 'acme', name: 'x', scopes: [] })).toThrow(
      TenantStoreError
    );
  });

  it('keeps every credential bound to its own tenant', () => {
    const acme = db.tenants.issue({ tenantId: 'acme', name: 'a', scopes: ['models:read'] });
    const globex = db.tenants.issue({ tenantId: 'globex', name: 'g', scopes: ['models:read'] });
    expect(db.authenticate(acme.plaintext)?.tenantId).toBe('acme');
    expect(db.authenticate(globex.plaintext)?.tenantId).toBe('globex');
    expect(db.tenants.list('acme').map((key) => key.id)).not.toContain(globex.key.id);
  });
});

describe('revocation and expiry', () => {
  it('rejects scope checks once a key is revoked', () => {
    const issued = db.tenants.issue({ tenantId: 'acme', name: 'a', scopes: ['models:read'] });
    expect(db.tenants.revoke('acme', issued.key.id)).toBe(true);
    const record = db.authenticate(issued.plaintext);
    expect(record?.revokedAt).not.toBeNull();
    expect(() => requireScope(record!, 'models:read')).toThrow(AuthError);
  });

  it('will not let one tenant revoke another tenant key', () => {
    const issued = db.tenants.issue({ tenantId: 'acme', name: 'a', scopes: ['models:read'] });
    expect(db.tenants.revoke('globex', issued.key.id)).toBe(false);
    expect(db.authenticate(issued.plaintext)?.revokedAt).toBeNull();
  });

  it('treats an expired key as unknown', () => {
    const issued = db.tenants.issue({
      tenantId: 'acme',
      name: 'a',
      scopes: ['models:read'],
      expiresInDays: 1
    });
    expect(db.authenticate(issued.plaintext)).not.toBeNull();
    db.db
      .prepare('UPDATE api_keys SET expires_at=? WHERE id=?')
      .run(new Date(Date.now() - 1000).toISOString(), issued.key.id);
    expect(db.authenticate(issued.plaintext)).toBeNull();
  });

  it('records last use without writing on every request', () => {
    const issued = db.tenants.issue({ tenantId: 'acme', name: 'a', scopes: ['models:read'] });
    db.authenticate(issued.plaintext);
    const first = db.tenants.find('acme', issued.key.id)?.lastUsedAt;
    expect(first).not.toBeNull();
    db.authenticate(issued.plaintext);
    expect(db.tenants.find('acme', issued.key.id)?.lastUsedAt).toBe(first);
  });
});

describe('rotation', () => {
  it('issues a replacement that inherits name, scopes, and mode', () => {
    const original = db.tenants.issue({
      tenantId: 'acme',
      name: 'service-account',
      scopes: ['models:read', 'chat:write'],
      mode: 'test'
    });
    const rotated = db.tenants.rotate('acme', original.key.id);
    expect(rotated.key.name).toBe('service-account');
    expect(rotated.key.mode).toBe('test');
    expect(rotated.key.scopes).toEqual(['models:read', 'chat:write']);
    expect(rotated.key.rotatedFrom).toBe(original.key.id);
    expect(rotated.plaintext).not.toBe(original.plaintext);
  });

  it('retires the previous key immediately without a grace window', () => {
    const original = db.tenants.issue({ tenantId: 'acme', name: 'a', scopes: ['models:read'] });
    const rotated = db.tenants.rotate('acme', original.key.id);
    expect(db.authenticate(original.plaintext)?.revokedAt).not.toBeNull();
    expect(db.authenticate(rotated.plaintext)?.revokedAt).toBeNull();
  });

  it('keeps the previous key usable during the grace window', () => {
    const original = db.tenants.issue({ tenantId: 'acme', name: 'a', scopes: ['models:read'] });
    const rotated = db.tenants.rotate('acme', original.key.id, { graceMinutes: 10 });
    const previous = db.authenticate(original.plaintext);
    expect(previous?.revokedAt).toBeNull();
    expect(() => requireScope(previous!, 'models:read')).not.toThrow();
    expect(db.authenticate(rotated.plaintext)?.revokedAt).toBeNull();
  });

  it('refuses to rotate an unknown or already revoked key', () => {
    const issued = db.tenants.issue({ tenantId: 'acme', name: 'a', scopes: ['models:read'] });
    expect(() => db.tenants.rotate('acme', 'missing')).toThrow(TenantStoreError);
    db.tenants.revoke('acme', issued.key.id);
    expect(() => db.tenants.rotate('acme', issued.key.id)).toThrow(TenantStoreError);
  });
});

describe('per-tenant limits', () => {
  it('applies a tenant budget below the deployment default', () => {
    db.tenants.setLimits('acme', { dailyBudgetUnits: 10, maxConcurrent: 2, rateLimitRpm: 60 });
    expect(() => db.reserveBudget('acme', 'req-1', 11, 10_000)).toThrow('daily_budget_exceeded');
    expect(db.reserveBudget('acme', 'req-2', 5, 10_000)).toBeTruthy();
  });

  it('never lets a tenant limit exceed the deployment ceiling', () => {
    db.tenants.setLimits('acme', {
      dailyBudgetUnits: 1_000_000,
      maxConcurrent: 2,
      rateLimitRpm: 60
    });
    expect(() => db.reserveBudget('acme', 'req-1', 50, 20)).toThrow('daily_budget_exceeded');
  });

  it('falls back to the deployment default when unset', () => {
    expect(db.tenants.limits('globex')).toBeNull();
    expect(db.reserveBudget('globex', 'req-1', 5, 10)).toBeTruthy();
  });
});
