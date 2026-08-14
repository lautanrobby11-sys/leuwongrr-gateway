import { afterEach, describe, expect, it } from 'vitest';
import { createTempDatabase } from './support/harness.js';

let fixture: ReturnType<typeof createTempDatabase> | null = null;
afterEach(() => { fixture?.dispose(); fixture = null; });

describe('payment order settlement schema', () => {
  it('stores an entitlement snapshot and explicit settlement state', () => {
    fixture = createTempDatabase();
    const { db } = fixture;
    db.db.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('tenant-payment', 'Payment', datetime('now'))").run();
    db.db.prepare("INSERT INTO accounts (id, tenant_id, email, display_name, role, status, created_at) VALUES ('harness-account', 'tenant-payment', 'payment@example.test', 'Payment', 'member', 'active', datetime('now'))").run();
    const columns = db.db.prepare('PRAGMA table_info(payments)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'entitlement_snapshot_json', 'balance_cents', 'token_amount', 'settlement_status', 'settlement_error'
    ]));
    db.db.prepare(`INSERT INTO payments
      (id, account_id, order_id, purpose, tokens, token_amount, balance_cents, amount_cents, currency, status, settlement_status, entitlement_snapshot_json, created_at)
      VALUES ('payment-1', 'harness-account', 'order-1', 'topup', 10, 10, 0, 100, 'USD', 'check', 'pending', ?, datetime('now'))`)
      .run(JSON.stringify({ method: 'token_pack', modelGroupId: 'value' }));
    expect(db.db.prepare('SELECT settlement_status, entitlement_snapshot_json FROM payments WHERE id = ?').get('payment-1')).toMatchObject({ settlement_status: 'pending' });
  });

  it('preserves the monetary-pack method on plans and subscriptions', () => {
    fixture = createTempDatabase();
    const { db } = fixture;
    db.db.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('tenant-monetary', 'Monetary', datetime('now'))").run();
    db.db.prepare("INSERT INTO accounts (id, tenant_id, email, display_name, role, status, created_at) VALUES ('monetary-account', 'tenant-monetary', 'monetary@example.test', 'Monetary', 'member', 'active', datetime('now'))").run();
    db.db.prepare("INSERT INTO plans (id, name, monthly_price_cents, included_tokens, overage_cents_per_million, max_concurrent, rate_limit_rpm, daily_budget_units, models_json, active, updated_at, method, model_group_id) VALUES ('monetary-plan', 'Monetary', 1000, 0, 1, 1, 1, 1000, '[]', 1, datetime('now'), 'monetary_pack', 'legacy-default')").run();
    db.db.prepare("INSERT INTO subscriptions (id, account_id, plan_id, status, period_start, period_end, included_tokens, used_tokens, auto_renew, created_at, updated_at, method, model_group_id, balance_cents) VALUES ('monetary-subscription', 'monetary-account', 'monetary-plan', 'active', datetime('now'), datetime('now', '+1 day'), 0, 0, 1, datetime('now'), datetime('now'), 'monetary_pack', 'legacy-default', 1000)").run();
    expect(db.db.prepare('SELECT method FROM plans WHERE id = ?').get('monetary-plan')).toEqual({ method: 'monetary_pack' });
    expect(db.db.prepare('SELECT method, balance_cents FROM subscriptions WHERE id = ?').get('monetary-subscription')).toEqual({ method: 'monetary_pack', balance_cents: 1000 });
    expect(db.db.pragma('foreign_key_check')).toEqual([]);
  });
});
