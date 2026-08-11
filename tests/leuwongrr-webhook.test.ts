import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import { createHarness, testConfig, type Harness } from './support/harness.js';
import { AccountStore } from '../src/accounts/store.js';
import { BillingService } from '../src/billing/service.js';

const SECRET = 'w'.repeat(32);

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
});

function sign(body: object): string {
  return createHmac('sha256', SECRET).update(JSON.stringify(body), 'utf8').digest('hex');
}

function post(app: Harness['app'], body: object, extra: { signature?: string; headers?: Record<string, string> } = {}) {
  return app.inject({
    method: 'POST',
    url: '/webhooks/leuwongrr',
    payload: body,
    headers: { 'x-leuwongrr-signature': extra.signature ?? sign(body), ...(extra.headers ?? {}) }
  });
}

/** Open a leuwongrr invoice for rndIdr IDR and rndTokens tokens. */
function openInvoice(amountIdr: number, tokens: number = 0) {
  const active = createHarness(() => new Response('{}'), {
    CONSOLE_ENABLED: true,
    LEUWONGRR_WEBHOOK_SECRET: SECRET,
    CRYPTOMUS_MERCHANT_ID: 'test',
    CRYPTOMUS_PAYMENT_API_KEY: 'test'
  });
  harness = active;
  const accounts = new AccountStore(active.db.db, testConfig.API_KEY_PEPPER);
  const billing = new BillingService(active.db.db);
  const account = accounts.create({ email: `payer-${randomUUID()}@example.com` });
  const orderId = `topup-${randomUUID()}`;
  active.db.db
    .prepare(
      `INSERT INTO payments (id, account_id, provider, order_id, invoice_uuid, purpose, plan_id, tokens, amount_cents, currency, status, payment_url, created_at)
       VALUES (?, ?, 'leuwongrr', ?, NULL, 'topup', NULL, ?, ?, 'IDR', 'pending', NULL, ?)`
    )
    .run(randomUUID(), account.id, orderId, tokens, amountIdr, new Date().toISOString());
  return { app: active.app, billing, accountId: account.id, orderId };
}

describe('leuwongrr.online webhook', () => {
  it('503 when secret not configured', async () => {
    const active = createHarness(() => new Response('{}'), {
      CONSOLE_ENABLED: true,
      LEUWONGRR_WEBHOOK_SECRET: undefined,
      CRYPTOMUS_MERCHANT_ID: 'test',
      CRYPTOMUS_PAYMENT_API_KEY: 'test'
    });
    harness = active;
    const res = await active.app.inject({ method: 'POST', url: '/webhooks/leuwongrr', payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('webhook_not_configured');
  });

  it('403 unsigned body', async () => {
    const { app } = openInvoice(50000);
    const res = await app.inject({ method: 'POST', url: '/webhooks/leuwongrr', payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('signature_invalid');
  });

  it('403 invalid signature', async () => {
    const { app } = openInvoice(50000);
    const body = { order_id: 'does-not-exist', amount_idr: 50000, status: 'paid' };
    const res = await post(app, body, { signature: 'bad' });
    expect(res.statusCode).toBe(403);
  });

  it('400 missing fields', async () => {
    const { app, orderId } = openInvoice(50000);
    const res = await post(app, { order_id: orderId });
    expect(res.statusCode).toBe(400);
  });

  it('404 unknown order', async () => {
    const { app } = openInvoice(50000);
    const res = await post(app, { order_id: 'unknown', amount_idr: 50000, status: 'paid' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('payment_not_found');
  });

  it('409 amount mismatch', async () => {
    const { app, orderId } = openInvoice(50000);
    const res = await post(app, { order_id: orderId, amount_idr: 1000, status: 'paid' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('payment_amount_mismatch');
  });

  it('409 currency mismatch', async () => {
    const { app, orderId } = openInvoice(50000);
    // Force currency to EUR
    (harness as Harness).db.db
      .prepare('UPDATE payments SET currency = ? WHERE order_id = ?')
      .run('EUR', orderId);
    const res = await post(app, { order_id: orderId, amount_idr: 50000, status: 'paid' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('payment_currency_mismatch');
  });

  it('settles and credits wallet on paid', async () => {
    const { app, billing, accountId, orderId } = openInvoice(16000, 0);
    // Exchange rate: 16000 IDR -> 50M tokens
    (harness as Harness).db.db
      .prepare("INSERT INTO exchange_rates (id, idr_per_usd, updated_at) VALUES ('default', 16000, ?)")
      .run(new Date().toISOString());
    const res = await post(app, { order_id: orderId, amount_idr: 16000, status: 'paid' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: true, duplicate: false });
    expect(billing.walletBalance(accountId)).toBe(50_000_000);
  });

  it('duplicate on retry without double credit', async () => {
    const { app, billing, accountId, orderId } = openInvoice(16000);
    (harness as Harness).db.db
      .prepare("INSERT INTO exchange_rates (id, idr_per_usd, updated_at) VALUES ('default', 16000, ?)")
      .run(new Date().toISOString());
    await post(app, { order_id: orderId, amount_idr: 16000, status: 'paid' });
    const retry = await post(app, { order_id: orderId, amount_idr: 16000, status: 'paid' });
    expect(retry.json()).toMatchObject({ accepted: true, duplicate: true });
    expect(billing.walletBalance(accountId)).toBe(50_000_000);
  });

  it('second paid_over is recorded not granted', async () => {
    const { app, billing, accountId, orderId } = openInvoice(16000);
    (harness as Harness).db.db
      .prepare("INSERT INTO exchange_rates (id, idr_per_usd, updated_at) VALUES ('default', 16000, ?)")
      .run(new Date().toISOString());
    await post(app, { order_id: orderId, amount_idr: 16000, status: 'paid' });
    const over = await post(app, { order_id: orderId, amount_idr: 24000, status: 'paid_over' });
    expect(over.statusCode).toBe(200);
    expect(billing.walletBalance(accountId)).toBe(50_000_000);
  });

  it('503 when exchange rate absent', async () => {
    const { app, orderId } = openInvoice(16000);
    const res = await post(app, { order_id: orderId, amount_idr: 16000, status: 'paid' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('exchange_rate_not_configured');
  });
});
