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
});
