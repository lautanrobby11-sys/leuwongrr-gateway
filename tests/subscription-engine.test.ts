import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTempDatabase, testConfig } from './support/harness.js';
import { AccountStore } from '../src/accounts/store.js';
import { BillingError, BillingService } from '../src/billing/service.js';
import type { Plan } from '../src/billing/service.js';
import type { GatewayDatabase } from '../src/persistence/database.js';

let dispose: (() => void) | null = null;

afterEach(() => {
  dispose?.();
  dispose = null;
});

const EPOCH = '2026-08-11T00:00:00.000Z';

function setup() {
  const temp = createTempDatabase();
  dispose = temp.dispose;
  const accounts = new AccountStore(temp.db.db, testConfig.API_KEY_PEPPER);
  let nowMs = Date.parse(EPOCH);
  const billing = new BillingService(temp.db.db, () => new Date(nowMs));
  const account = accounts.create({ email: `member-${randomUUID()}@example.com` });
  return {
    db: temp.db,
    billing,
    account,
    advance(hours: number): void {
      nowMs += hours * 3_600_000;
    }
  };
}

function settleUsage(
  db: GatewayDatabase,
  tenantId: string,
  units: number,
  createdAt = EPOCH
): void {
  db.db
    .prepare(
      "INSERT INTO usage_events (id, tenant_id, request_id, units, state, day, created_at) VALUES (?, ?, ?, ?, 'settled', ?, ?)"
    )
    .run(randomUUID(), tenantId, randomUUID(), units, createdAt.slice(0, 10), createdAt);
}

function basePlan(id: string): Plan {
  return {
    id,
    name: id,
    monthlyPriceCents: 0,
    includedTokens: 0,
    overageCentsPerMillion: 100,
    maxConcurrent: 1,
    rateLimitRpm: 10,
    dailyBudgetUnits: 100,
    models: ['lwrr-text'],
    active: true
  };
}

function rollingPlan(
  id: string,
  includedTokens: number,
  durationHours: number,
  timerBasis: 'from_payment' | 'from_first_use' = 'from_payment',
  resetsAllowed = 1
): Plan {
  return {
    ...basePlan(id),
    includedTokens,
    priceCents: 50_000,
    durationHours,
    timerBasis,
    resetsAllowed,
    method: 'rolling_time',
    tierLabel: 'Rolling'
  };
}

function packPlan(
  id: string,
  includedTokens: number,
  durationHours: number,
  resetsAllowed = 0
): Plan {
  return {
    ...basePlan(id),
    includedTokens,
    priceCents: 30_000,
    durationHours,
    timerBasis: 'from_payment',
    resetsAllowed,
    method: 'token_pack',
    tierLabel: 'Brown'
  };
}

describe('rolling time (spec 20.2/20.3)', () => {
  it('serves requests for free inside the window without touching the wallet', () => {
    const { db, billing, account } = setup();
    billing.credit(account.id, 1_000, 'admin', 'seed', 'adjustment');
    billing.upsertPlan(rollingPlan('rt', 100, 6));
    const sub = billing.startSubscription(account.id, 'rt');

    settleUsage(db, account.tenantId, 40);
    billing.reconcile(account.id, account.tenantId);

    expect(billing.getSubscription(sub.id)?.usedTokens).toBe(40);
    expect(billing.walletBalance(account.id)).toBe(1_000);
  });

  it('spends the wallet once the free limit is exhausted', () => {
    const { db, billing, account } = setup();
    billing.credit(account.id, 1_000, 'admin', 'seed', 'adjustment');
    billing.upsertPlan(rollingPlan('rt', 100, 6));
    const sub = billing.startSubscription(account.id, 'rt');

    settleUsage(db, account.tenantId, 100);
    billing.reconcile(account.id, account.tenantId);
    expect(billing.getSubscription(sub.id)?.usedTokens).toBe(100);

    settleUsage(db, account.tenantId, 25);
    billing.reconcile(account.id, account.tenantId);
    expect(billing.getSubscription(sub.id)?.usedTokens).toBe(100);
    expect(billing.walletBalance(account.id)).toBe(975);
  });

  it('activates a from_first_use timer on the first request and only then', () => {
    const { db, billing, account, advance } = setup();
    billing.credit(account.id, 1_000, 'admin', 'seed', 'adjustment');
    billing.upsertPlan(rollingPlan('rt', 100, 6, 'from_first_use'));
    const sub = billing.startSubscription(account.id, 'rt');
    expect(sub.activatedAt).toBeNull();

    settleUsage(db, account.tenantId, 30);
    billing.reconcile(account.id, account.tenantId);
    const active = billing.getSubscription(sub.id)!;
    expect(active.activatedAt).toBe(EPOCH);
    expect(active.expiresAt).toBe('2026-08-11T06:00:00.000Z');
    expect(active.usedTokens).toBe(30);

    // The window runs from first use: an hour later the timer still counts.
    advance(1);
    settleUsage(db, account.tenantId, 20, '2026-08-11T01:00:00.000Z');
    billing.reconcile(account.id, account.tenantId);
    expect(billing.getSubscription(sub.id)?.usedTokens).toBe(50);
  });

  it('stops funding once the window expires', () => {
    const { db, billing, account, advance } = setup();
    billing.credit(account.id, 1_000, 'admin', 'seed', 'adjustment');
    billing.upsertPlan(rollingPlan('rt', 100, 1));
    const sub = billing.startSubscription(account.id, 'rt');

    advance(2);
    settleUsage(db, account.tenantId, 30, '2026-08-11T02:00:00.000Z');
    billing.reconcile(account.id, account.tenantId);

    expect(billing.getSubscription(sub.id)?.usedTokens).toBe(0);
    expect(billing.walletBalance(account.id)).toBe(970);
  });

  it('a new rolling time purchase replaces the old timer', () => {
    const { billing, account } = setup();
    billing.upsertPlan(rollingPlan('rt', 100, 6, 'from_payment', 0));
    const first = billing.startSubscription(account.id, 'rt');
    billing.upsertPlan(rollingPlan('rt2', 100, 6, 'from_payment', 0));
    const second = billing.startSubscription(account.id, 'rt2');

    expect(billing.getSubscription(first.id)?.status).toBe('canceled');
    expect(billing.getSubscription(second.id)?.status).toBe('active');
  });
});

describe('token packs (spec 20.4)', () => {
  it('pays from packs in earliest-expiry order after rolling time', () => {
    const { db, billing, account, advance } = setup();
    billing.credit(account.id, 1_000, 'admin', 'seed', 'adjustment');
    billing.upsertPlan(rollingPlan('rt', 100, 6));
    billing.upsertPlan(packPlan('early', 100, 2));
    billing.upsertPlan(packPlan('late', 100, 4));
    const rt = billing.startSubscription(account.id, 'rt');
    const early = billing.startSubscription(account.id, 'early');
    advance(1);
    const late = billing.startSubscription(account.id, 'late');

    settleUsage(db, account.tenantId, 250, '2026-08-11T01:00:00.000Z');
    billing.reconcile(account.id, account.tenantId);

    // 100 free from rolling time, then the pack that expires first, then the next.
    expect(billing.getSubscription(rt.id)?.usedTokens).toBe(100);
    expect(billing.getSubscription(early.id)?.usedTokens).toBe(100);
    expect(billing.getSubscription(late.id)?.usedTokens).toBe(50);
    expect(billing.walletBalance(account.id)).toBe(1_000);
  });

  it('a pack purchase stacks instead of cancelling live packs', () => {
    const { billing, account } = setup();
    billing.upsertPlan(packPlan('p1', 100, 24));
    billing.upsertPlan(packPlan('p2', 100, 24));
    const first = billing.startSubscription(account.id, 'p1');
    const second = billing.startSubscription(account.id, 'p2');

    expect(billing.getSubscription(first.id)?.status).toBe('active');
    expect(billing.getSubscription(second.id)?.status).toBe('active');
  });

  it('a pack still works while a rolling time window is exhausted', () => {
    const { db, billing, account } = setup();
    billing.upsertPlan(rollingPlan('rt', 50, 6));
    billing.upsertPlan(packPlan('pack', 100, 24));
    const rt = billing.startSubscription(account.id, 'rt');
    const pack = billing.startSubscription(account.id, 'pack');

    settleUsage(db, account.tenantId, 120);
    billing.reconcile(account.id, account.tenantId);

    expect(billing.getSubscription(rt.id)?.usedTokens).toBe(50);
    expect(billing.getSubscription(pack.id)?.usedTokens).toBe(70);
  });
});

describe('reset (spec 20.3/20.4)', () => {
  it('restarts the timer, restores the allowance and spends one reset', () => {
    const { db, billing, account, advance } = setup();
    billing.upsertPlan(rollingPlan('rt', 100, 6, 'from_payment', 2));
    const sub = billing.startSubscription(account.id, 'rt');

    settleUsage(db, account.tenantId, 70);
    billing.reconcile(account.id, account.tenantId);

    advance(1);
    const reset = billing.resetSubscription(sub.id);
    expect(reset.usedTokens).toBe(0);
    expect(reset.resetsRemaining).toBe(1);
    expect(reset.activatedAt).toBe('2026-08-11T01:00:00.000Z');
    expect(reset.expiresAt).toBe('2026-08-11T07:00:00.000Z');
  });

  it('refuses a reset when none remain', () => {
    const { billing, account } = setup();
    billing.upsertPlan(rollingPlan('rt', 100, 6, 'from_payment', 0));
    const sub = billing.startSubscription(account.id, 'rt');

    expect(() => billing.resetSubscription(sub.id)).toThrowError(
      expect.objectContaining<Partial<BillingError>>({ code: 'subscription_reset_unavailable', statusCode: 409 })
    );
  });

  it('refuses a racing second reset (double-click) with 409', () => {
    const { billing, account } = setup();
    billing.upsertPlan(rollingPlan('rt', 100, 6, 'from_payment', 1));
    const sub = billing.startSubscription(account.id, 'rt');

    billing.resetSubscription(sub.id);
    expect(() => billing.resetSubscription(sub.id)).toThrowError(
      expect.objectContaining<Partial<BillingError>>({ code: 'subscription_reset_unavailable', statusCode: 409 })
    );
  });
});

describe('snapshot and funding gate (spec 20.4/20.5)', () => {
  it('keeps the purchased allowance after the plan is edited', () => {
    const { billing, account } = setup();
    billing.upsertPlan(rollingPlan('rt', 100, 6));
    const sub = billing.startSubscription(account.id, 'rt');

    billing.upsertPlan({ ...rollingPlan('rt', 9_999, 6), includedTokens: 9_999 });

    expect(billing.getSubscription(sub.id)?.includedTokens).toBe(100);
    expect(billing.getPlan('rt')?.includedTokens).toBe(9_999);
  });

  it('funds a live rolling time window even with an empty wallet', () => {
    const { billing, account } = setup();
    billing.upsertPlan(rollingPlan('rt', 100, 6));
    billing.startSubscription(account.id, 'rt');

    expect(() => billing.assertFunded(account.id, account.tenantId)).not.toThrow();
  });

  it('funds a pending from_first_use timer so the first request can activate it', () => {
    const { billing, account } = setup();
    billing.upsertPlan(rollingPlan('rt', 100, 6, 'from_first_use'));
    billing.startSubscription(account.id, 'rt');

    expect(() => billing.assertFunded(account.id, account.tenantId)).not.toThrow();
  });

  it('refuses when every window is expired and the wallet is empty', () => {
    const { billing, account, advance } = setup();
    billing.upsertPlan(rollingPlan('rt', 100, 1));
    billing.startSubscription(account.id, 'rt');
    advance(2);

    expect(() => billing.assertFunded(account.id, account.tenantId)).toThrowError(
      expect.objectContaining<Partial<BillingError>>({ code: 'insufficient_tokens', statusCode: 402 })
    );
  });
});
