import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createHarness, testConfig, type Harness } from './support/harness.js';
import { AccountStore } from '../src/accounts/store.js';
import { BillingService } from '../src/billing/service.js';
import { signPayload } from '../src/payments/cryptomus.js';

const API_KEY = 'cryptomus-test-payment-api-key';
const TOKENS = 500_000;
const INVOICE_CENTS = 1000;

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
});

/** Cryptomus signs the PHP encoding of the body, so the fixture mirrors it. */
function phpJson(value: unknown): string {
  return JSON.stringify(value).replace(/\//g, '\\/');
}

function signed(payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, sign: signPayload(phpJson(payload), API_KEY) };
}

/** An account with one open $10.00 invoice worth 500k tokens. */
function openInvoice() {
  const active = createHarness(
    () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    {
      CONSOLE_ENABLED: true,
      CRYPTOMUS_MERCHANT_ID: 'merchant-test',
      CRYPTOMUS_PAYMENT_API_KEY: API_KEY
    }
  );
  harness = active;
  const accounts = new AccountStore(active.db.db, testConfig.API_KEY_PEPPER);
  const billing = new BillingService(active.db.db);
  const account = accounts.create({ email: `payer-${randomUUID()}@example.com` });
  const orderId = `topup-${randomUUID()}`;
  active.db.db
    .prepare(
      `INSERT INTO payments (id, account_id, provider, order_id, invoice_uuid, purpose, plan_id, tokens, amount_cents, currency, status, payment_url, created_at)
       VALUES (?, ?, 'cryptomus', ?, ?, 'topup', NULL, ?, ?, 'USD', 'check', NULL, ?)`
    )
    .run(
      randomUUID(),
      account.id,
      orderId,
      randomUUID(),
      TOKENS,
      INVOICE_CENTS,
      new Date().toISOString()
    );
  return { app: active.app, billing, accountId: account.id, orderId };
}

function post(app: Harness['app'], payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/webhooks/cryptomus', payload });
}

describe('cryptomus settlement', () => {
  it('credits once and treats the provider retry as a duplicate', async () => {
    const { app, billing, accountId, orderId } = openInvoice();
    const payload = signed({ order_id: orderId, status: 'paid', amount: '10.00', currency: 'USD' });

    const first = await post(app, payload);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ accepted: true, duplicate: false });
    expect(billing.walletBalance(accountId)).toBe(TOKENS);

    const retry = await post(app, payload);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ duplicate: true });
    expect(billing.walletBalance(accountId)).toBe(TOKENS);
    const row = (harness as Harness).db.db.prepare('SELECT settlement_status FROM payments WHERE order_id = ?').get(orderId) as { settlement_status: string };
    expect(row.settlement_status).toBe('settled');
  });

  it('does not grant again when the status later becomes paid_over', async () => {
    const { app, billing, accountId, orderId } = openInvoice();
    await post(app, signed({ order_id: orderId, status: 'paid', amount: '10.00', currency: 'USD' }));

    const over = await post(
      app,
      signed({ order_id: orderId, status: 'paid_over', amount: '12.00', currency: 'USD' })
    );
    expect(over.statusCode).toBe(200);
    expect(billing.walletBalance(accountId)).toBe(TOKENS);
  });

  it('refuses a callback that understates the invoice', async () => {
    const { app, billing, accountId, orderId } = openInvoice();
    const response = await post(
      app,
      signed({ order_id: orderId, status: 'paid', amount: '1.00', currency: 'USD' })
    );
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('payment_amount_mismatch');
    expect(billing.walletBalance(accountId)).toBe(0);
  });

  it('refuses a callback that settles in another currency', async () => {
    const { app, billing, accountId, orderId } = openInvoice();
    const response = await post(
      app,
      signed({ order_id: orderId, status: 'paid', amount: '10.00', currency: 'EUR' })
    );
    expect(response.statusCode).toBe(409);
    expect(billing.walletBalance(accountId)).toBe(0);
  });

  it('keeps a settled payment settled when a failure notice arrives late', async () => {
    const { app, billing, accountId, orderId } = openInvoice();
    await post(app, signed({ order_id: orderId, status: 'paid', amount: '10.00', currency: 'USD' }));

    const late = await post(app, signed({ order_id: orderId, status: 'cancel' }));
    expect(late.statusCode).toBe(200);
    expect(billing.walletBalance(accountId)).toBe(TOKENS);
    const row = (harness as Harness).db.db
      .prepare('SELECT status, settled_at FROM payments WHERE order_id = ?')
      .get(orderId) as { status: string; settled_at: string | null };
    expect(row.status).toBe('paid');
    expect(row.settled_at).not.toBeNull();
  });

  it('marks malformed entitlement snapshots for reconciliation without granting', async () => {
    const { app, billing, accountId, orderId } = openInvoice();
    (harness as Harness).db.db.prepare('UPDATE payments SET entitlement_snapshot_json = ? WHERE order_id = ?').run('{bad', orderId);
    const response = await post(app, signed({ order_id: orderId, status: 'paid', amount: '10.00', currency: 'USD' }));
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('payment_reconciliation_required');
    expect(billing.walletBalance(accountId)).toBe(0);
    const row = (harness as Harness).db.db.prepare('SELECT settlement_status, settlement_error, settled_at FROM payments WHERE order_id = ?').get(orderId) as { settlement_status: string; settlement_error: string; settled_at: string | null };
    expect(row).toMatchObject({ settlement_status: 'reconciliation_required', settlement_error: 'entitlement_snapshot_invalid', settled_at: null });
  });

  it('rejects invalid settlement amounts and methods without negative balances', async () => {
    const { billing, accountId, orderId } = openInvoice();
    expect(() => billing.settlePaymentSnapshot(accountId, orderId + '-wrong', { method: 'payg', balanceCents: -1 })).toThrowError('payment_scope_invalid');
    expect(billing.walletBalance(accountId)).toBe(0);
  });

  it('rolls back a failed grant atomically', async () => {
    const { app, billing, accountId, orderId } = openInvoice();
    (harness as Harness).db.db.prepare('UPDATE payments SET entitlement_snapshot_json = ? WHERE order_id = ?').run(JSON.stringify({ method: 'rolling_time', planId: 'missing-plan', amountCents: 1000 }), orderId);
    const response = await post(app, signed({ order_id: orderId, status: 'paid', amount: '10.00', currency: 'USD' }));
    expect(response.statusCode).toBe(409);
    expect(billing.walletBalance(accountId)).toBe(0);
    const db = (harness as Harness).db.db;
    expect((db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE account_id = ? AND source = 'payment'").get(accountId) as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE account_id = ?').get(accountId) as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM payment_events WHERE payment_id = (SELECT id FROM payments WHERE order_id = ?)').get(orderId) as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT settlement_status FROM payments WHERE order_id = ?').get(orderId) as { settlement_status: string }).settlement_status).toBe('reconciliation_required');
  });

  it('rejects an unsigned body and an unknown order', async () => {
    const { app, orderId } = openInvoice();
    const unsigned = await post(app, {
      order_id: orderId,
      status: 'paid',
      amount: '10.00',
      currency: 'USD'
    });
    expect(unsigned.statusCode).toBe(403);

    const unknown = await post(
      app,
      signed({ order_id: 'topup-does-not-exist', status: 'paid', amount: '10.00', currency: 'USD' })
    );
    expect(unknown.statusCode).toBe(404);
  });
});
