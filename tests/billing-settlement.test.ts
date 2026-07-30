import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTempDatabase, testConfig } from './support/harness.js';
import { AccountStore } from '../src/accounts/store.js';
import { BillingService } from '../src/billing/service.js';
import type { GatewayDatabase } from '../src/persistence/database.js';

let dispose: (() => void) | null = null;

afterEach(() => {
  dispose?.();
  dispose = null;
});

function setup() {
  const temp = createTempDatabase();
  dispose = temp.dispose;
  const accounts = new AccountStore(temp.db.db, testConfig.API_KEY_PEPPER);
  const billing = new BillingService(temp.db.db);
  const account = accounts.create({ email: `member-${randomUUID()}@example.com` });
  return { db: temp.db, billing, account };
}

function settleUsage(
  db: GatewayDatabase,
  tenantId: string,
  units: number,
  createdAt: string
): void {
  db.db
    .prepare(
      "INSERT INTO usage_events (id, tenant_id, request_id, units, state, day, created_at) VALUES (?, ?, ?, ?, 'settled', ?, ?)"
    )
    .run(randomUUID(), tenantId, randomUUID(), units, createdAt.slice(0, 10), createdAt);
}

function plan(id: string, models: string[]) {
  return {
    id,
    name: id,
    monthlyPriceCents: 0,
    includedTokens: 0,
    overageCentsPerMillion: 100,
    maxConcurrent: 1,
    rateLimitRpm: 10,
    dailyBudgetUnits: 100,
    models
  };
}

describe('usage reconciliation', () => {
  it('bills a row written on the same timestamp as the cursor', () => {
    const { db, billing, account } = setup();
    const stamp = '2026-07-29T00:00:00.000Z';
    billing.credit(account.id, 100, 'admin', 'seed', 'adjustment');

    settleUsage(db, account.tenantId, 10, stamp);
    billing.reconcile(account.id, account.tenantId);
    expect(billing.walletBalance(account.id)).toBe(90);

    // Metering can write a second row inside the same millisecond. A strict
    // greater-than cursor would hand this one out for free.
    settleUsage(db, account.tenantId, 10, stamp);
    billing.reconcile(account.id, account.tenantId);
    expect(billing.walletBalance(account.id)).toBe(80);
  });

  it('never bills the same usage event twice', () => {
    const { db, billing, account } = setup();
    billing.credit(account.id, 50, 'admin', 'seed', 'adjustment');
    settleUsage(db, account.tenantId, 20, '2026-07-29T01:00:00.000Z');

    billing.reconcile(account.id, account.tenantId);
    billing.reconcile(account.id, account.tenantId);
    expect(billing.walletBalance(account.id)).toBe(30);
  });

  it('marks a zero unit event as processed instead of revisiting it', () => {
    const { db, billing, account } = setup();
    const stamp = '2026-07-29T02:00:00.000Z';
    billing.credit(account.id, 10, 'admin', 'seed', 'adjustment');
    settleUsage(db, account.tenantId, 0, stamp);

    billing.reconcile(account.id, account.tenantId);
    expect(billing.walletBalance(account.id)).toBe(10);
    const applied = db.db
      .prepare(
        "SELECT COUNT(*) AS total FROM ledger_entries WHERE account_id = ? AND source = 'usage'"
      )
      .get(account.id) as { total: number };
    expect(applied.total).toBe(1);
  });
});

describe('plan entitlement envelope', () => {
  it('withdraws models the new plan does not include', () => {
    const { db, billing, account } = setup();
    billing.upsertPlan(plan('starter', ['lwrr-text']));
    billing.upsertPlan(plan('audio', ['lwrr-audio']));

    billing.startSubscription(account.id, 'starter');
    expect(enabledModels(db, account.tenantId)).toEqual(['lwrr-text']);

    billing.startSubscription(account.id, 'audio');
    expect(enabledModels(db, account.tenantId)).toEqual(['lwrr-audio']);
  });
});

describe('plan catalogue visibility', () => {
  it('exposes an upserted plan to the active-only listing the console reads', () => {
    const { billing } = setup();
    expect(billing.listPlans(true)).toEqual([]);

    const stored = billing.upsertPlan(plan('starter', ['lwrr-text']));

    expect(stored.active).toBe(true);
    expect(billing.listPlans(true).map((entry) => entry.id)).toEqual(['starter']);
  });

  it('hides an inactive plan from the active listing but keeps it on record', () => {
    const { billing } = setup();
    billing.upsertPlan({ ...plan('retired', ['lwrr-text']), active: false });

    expect(billing.listPlans(true)).toEqual([]);
    expect(billing.listPlans().map((entry) => entry.id)).toEqual(['retired']);
  });
});

describe('account roles', () => {
  /**
   * Mirrors the literal set requireAdmin accepts in src/http/console.ts rather
   * than exporting it, so a widening there has to be a deliberate edit here too.
   */
  const ADMIN_ROLES = new Set(['admin', 'owner']);

  it('creates members that the admin guard rejects, and promotes them', () => {
    const temp = createTempDatabase();
    dispose = temp.dispose;
    const accounts = new AccountStore(temp.db.db, testConfig.API_KEY_PEPPER);
    const account = accounts.create({ email: `owner-${randomUUID()}@example.com` });

    expect(account.role).toBe('member');
    expect(ADMIN_ROLES.has(account.role)).toBe(false);

    accounts.setRole(account.id, 'admin');
    expect(accounts.findById(account.id)?.role).toBe('admin');
    expect(ADMIN_ROLES.has(accounts.findById(account.id)!.role)).toBe(true);

    accounts.setRole(account.id, 'owner');
    expect(ADMIN_ROLES.has(accounts.findById(account.id)!.role)).toBe(true);
  });
});

function enabledModels(db: GatewayDatabase, tenantId: string): string[] {
  const rows = db.db
    .prepare('SELECT model_id FROM model_policies WHERE tenant_id = ? AND enabled = 1 ORDER BY model_id')
    .all(tenantId) as Array<{ model_id: string }>;
  return rows.map((row) => row.model_id);
}
