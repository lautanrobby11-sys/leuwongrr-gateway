import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTempDatabase, testConfig } from './support/harness.js';
import { AccountStore } from '../src/accounts/store.js';
import { BillingService } from '../src/billing/service.js';

let dispose: (() => void) | null = null;
afterEach(() => { dispose?.(); dispose = null; });

function setup() {
  const temp = createTempDatabase(); dispose = temp.dispose;
  const account = new AccountStore(temp.db.db, testConfig.API_KEY_PEPPER).create({ email: `${randomUUID()}@example.com` });
  const billing = new BillingService(temp.db.db);
  temp.db.db.prepare("INSERT INTO model_groups (id, name, multiplier_bps, enabled, created_at, updated_at) VALUES ('value', 'Value', 10000, 1, datetime('now'), datetime('now'))").run();
  billing.upsertPlan({ id: 'pack', name: 'Pack', monthlyPriceCents: 1000, priceCents: 1000, includedTokens: 500000, overageCentsPerMillion: 100, maxConcurrent: 1, rateLimitRpm: 10, dailyBudgetUnits: 100, models: [], modelGroupId: 'value', active: true, method: 'token_pack' });
  billing.upsertPlan({ id: 'rolling', name: 'Rolling', monthlyPriceCents: 1000, priceCents: 1000, includedTokens: 500000, overageCentsPerMillion: 100, maxConcurrent: 1, rateLimitRpm: 10, dailyBudgetUnits: 100, models: [], modelGroupId: 'value', active: true, method: 'rolling_time', durationHours: 24 });
  return { db: temp.db.db, billing, account };
}
function createPayment() {
  const { db, billing, account } = setup();
  const paymentId = randomUUID();
  db.prepare("INSERT INTO payments (id, account_id, order_id, purpose, amount_cents, status, entitlement_snapshot_json, balance_cents, token_amount, created_at) VALUES (?, ?, ?, 'topup', 1000, 'paid', '{}', 0, 0, datetime('now'))").run(paymentId, account.id, paymentId);
  return { db, account, billing, paymentId };
}

function settle(kind: 'token_pack' | 'monetary_pack' | 'rolling_time' | 'payg') {
  const payment = createPayment();
  if (kind === 'monetary_pack' || kind === 'payg') payment.billing.startSubscription(payment.account.id, 'pack');
  const result = payment.billing.settlePaymentSnapshot(payment.account.id, payment.paymentId, { method: kind, planId: kind === 'rolling_time' ? 'rolling' : 'pack', modelGroupId: 'value', tokens: kind === 'token_pack' ? 500000 : 0, balanceCents: kind === 'monetary_pack' || kind === 'payg' ? 1000 : 0 });
  return { ...result, ...payment };
}

describe('multimode payment grants', () => {
  it('grants token packs without a cents balance', () => expect(settle('token_pack')).toMatchObject({ tokensGranted: 500000, centsGranted: 0 }));
  it('grants monetary packs as cents without converting to tokens', () => expect(settle('monetary_pack')).toMatchObject({ tokensGranted: 0, centsGranted: 1000 }));
  it('creates rolling subscriptions from the stored group snapshot', () => expect(settle('rolling_time').subscription?.modelGroupId).toBe('value'));
  it('credits PAYG cents and is idempotent on retry', () => {
    const first = settle('payg');
    const second = first.billing.settlePaymentSnapshot(first.account.id, first.paymentId, { method: 'payg', balanceCents: 1000 });
    expect(second).toMatchObject({ tokensGranted: 0, centsGranted: 0 });
    expect((first.db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE account_id = ? AND source = 'payment'").get(first.account.id) as { n: number }).n).toBe(1);
    expect((first.db.prepare('SELECT balance_tokens, balance_cents FROM wallets WHERE account_id = ?').get(first.account.id) as { balance_tokens: number; balance_cents: number })).toEqual({ balance_tokens: 0, balance_cents: 1000 });
  });

  it('rejects negative token grants', () => {
    const { billing, account, paymentId } = createPayment();
    expect(() => billing.settlePaymentSnapshot(account.id, paymentId, { method: 'token_pack', tokens: -1 })).toThrowError('payment_amount_invalid');
  });

  it('rejects negative cents grants', () => {
    const { billing, account, paymentId } = createPayment();
    expect(() => billing.settlePaymentSnapshot(account.id, paymentId, { method: 'payg', balanceCents: -1 })).toThrowError('payment_amount_invalid');
  });

  it('rejects fractional payment amounts', () => {
    const { billing, account, paymentId } = createPayment();
    expect(() => billing.settlePaymentSnapshot(account.id, paymentId, { method: 'payg', balanceCents: 1.5 })).toThrowError('payment_amount_invalid');
  });

  it('rejects an invalid settlement method', () => {
    const { billing, account, paymentId } = createPayment();
    expect(() => billing.settlePaymentSnapshot(account.id, paymentId, { method: 'invalid' as never, balanceCents: 1000 })).toThrowError('payment_method_invalid');
  });
});

/**
 * Release 2 custom token packs: a top-up snapshot carrying `durationHours`
 * settles into a duration subscription (its own shelf life) instead of the
 * permanent wallet, repeated purchases stack alongside existing packs, and a
 * malformed duration or a missing plan is rejected.
 */
describe('duration pack settlement', () => {
  it('settles a pack with a shelf life into a duration subscription', () => {
    const { db, billing, account } = setup();
    const paymentId = randomUUID();
    db.prepare("INSERT INTO payments (id, account_id, order_id, purpose, amount_cents, status, entitlement_snapshot_json, balance_cents, token_amount, created_at) VALUES (?, ?, ?, 'topup', 210, 'paid', '{}', 0, 0, datetime('now'))").run(paymentId, account.id, paymentId);

    const result = billing.settlePaymentSnapshot(account.id, paymentId, {
      method: 'token_pack',
      planId: 'pack',
      tokens: 1_000_000,
      balanceCents: 0,
      amountCents: 210,
      durationHours: 24
    });
    expect(result.tokensGranted).toBe(1_000_000);
    expect(result.centsGranted).toBe(0);
    expect(result.subscription?.durationHours).toBe(24);
    expect(result.subscription?.includedTokens).toBe(1_000_000);
    // The allowance lives in the subscription row, not the permanent wallet.
    expect((db.prepare('SELECT COALESCE(SUM(balance_tokens), 0) AS n FROM wallets WHERE account_id = ?').get(account.id) as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT tokens FROM ledger_entries WHERE account_id = ? AND source = 'subscription' AND reference = ?").get(account.id, result.subscription!.id) as { tokens: number }).tokens).toBe(1_000_000);
  });

  it('stacks repeated packs so each keeps its own countdown', () => {
    const { db, billing, account } = setup();
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids) {
      db.prepare("INSERT INTO payments (id, account_id, order_id, purpose, amount_cents, status, entitlement_snapshot_json, balance_cents, token_amount, created_at) VALUES (?, ?, ?, 'topup', 210, 'paid', '{}', 0, 0, datetime('now'))").run(id, account.id, id);
      billing.settlePaymentSnapshot(account.id, id, { method: 'token_pack', planId: 'pack', tokens: 1_000_000, balanceCents: 0, amountCents: 210, durationHours: 24 });
    }
    const packs = db.prepare("SELECT id FROM subscriptions WHERE account_id = ? AND status = 'active' AND method = 'token_pack'").all(account.id);
    expect(packs).toHaveLength(3);
  });

  it('rejects a duration pack without a plan', () => {
    const { billing, account, paymentId } = createPayment();
    expect(() =>
      billing.settlePaymentSnapshot(account.id, paymentId, { method: 'token_pack', tokens: 1_000_000, balanceCents: 0, amountCents: 210, durationHours: 24 })
    ).toThrowError('payment_plan_missing');
  });

  it('rejects an out-of-range shelf life', () => {
    const { billing, account, paymentId } = createPayment();
    expect(() =>
      billing.settlePaymentSnapshot(account.id, paymentId, { method: 'token_pack', planId: 'pack', tokens: 1_000_000, balanceCents: 0, amountCents: 210, durationHours: 0 })
    ).toThrowError('payment_amount_invalid');
  });
});
