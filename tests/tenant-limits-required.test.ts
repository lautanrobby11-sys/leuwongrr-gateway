import { afterEach, describe, expect, it } from 'vitest';
import { createTempDatabase, testConfig } from './support/harness.js';

let dispose: (() => void) | null = null;

afterEach(() => {
  dispose?.();
  dispose = null;
});

/**
 * Issue #47: a tenant created without an explicit `tenant_limits` row silently
 * inherited the global default (100000 units/day). Every tenant — including
 * quarantine/smoke tenants — must have an explicit row so the limit cannot
 * drift from what the operator intends.
 */
describe('tenant creation requires explicit limits (#47)', () => {
  it('writes a tenant_limits row when a tenant is created', () => {
    const temp = createTempDatabase();
    dispose = temp.dispose;
    temp.db.tenants.upsertTenant('smoke-quarantine-1', 'quarantine');

    const row = temp.db.db
      .prepare(
        'SELECT daily_budget_units, max_concurrent, rate_limit_rpm FROM tenant_limits WHERE tenant_id=?'
      )
      .get('smoke-quarantine-1') as
      | { daily_budget_units: number; max_concurrent: number; rate_limit_rpm: number }
      | undefined;

    expect(row).toBeDefined();
    // Explicit small quarantine limits, not the 100000-unit global default.
    expect(row?.daily_budget_units).toBeLessThan(testConfig.DAILY_BUDGET_UNITS);
    expect(row?.max_concurrent).toBeGreaterThan(0);
    expect(row?.rate_limit_rpm).toBeGreaterThan(0);
  });

  it('keeps an explicit setLimits row intact for an existing tenant', () => {
    const temp = createTempDatabase();
    dispose = temp.dispose;
    temp.db.tenants.upsertTenant('tenant-x', 'x');
    temp.db.tenants.setLimits('tenant-x', {
      dailyBudgetUnits: 1234,
      maxConcurrent: 2,
      rateLimitRpm: 10
    });

    const row = temp.db.db
      .prepare('SELECT daily_budget_units FROM tenant_limits WHERE tenant_id=?')
      .get('tenant-x') as { daily_budget_units: number } | undefined;
    expect(row?.daily_budget_units).toBe(1234);
  });
});
