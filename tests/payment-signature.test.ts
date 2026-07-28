import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signPayload, verifyWebhookSignature } from '../src/payments/cryptomus.js';
import { verifyTelegramLogin } from '../src/accounts/oauth.js';

const API_KEY = 'test-payment-api-key';

/** Mirrors PHP json_encode, which is what Cryptomus signs on their side. */
function phpJson(value: unknown): string {
  return JSON.stringify(value).replace(/\//g, '\\/');
}

describe('cryptomus webhook signature', () => {
  const payload = {
    order_id: 'topup-1',
    status: 'paid',
    amount: '10.00',
    url_callback: 'https://api.leuwongrr.cloud/webhooks/cryptomus'
  };

  it('accepts a signature produced with escaped slashes', () => {
    const sign = signPayload(phpJson(payload), API_KEY);
    expect(verifyWebhookSignature({ ...payload, sign }, API_KEY)).toBe(true);
  });

  it('accepts a signature produced without escaped slashes', () => {
    const sign = signPayload(JSON.stringify(payload), API_KEY);
    expect(verifyWebhookSignature({ ...payload, sign }, API_KEY)).toBe(true);
  });

  it('rejects a signature made with a different key', () => {
    const sign = signPayload(phpJson(payload), 'someone-elses-key');
    expect(verifyWebhookSignature({ ...payload, sign }, API_KEY)).toBe(false);
  });

  it('rejects a payload whose amount was altered after signing', () => {
    const sign = signPayload(phpJson(payload), API_KEY);
    expect(verifyWebhookSignature({ ...payload, amount: '1000.00', sign }, API_KEY)).toBe(false);
  });

  it('rejects a payload with no signature at all', () => {
    expect(verifyWebhookSignature(payload, API_KEY)).toBe(false);
    expect(verifyWebhookSignature({ ...payload, sign: 'short' }, API_KEY)).toBe(false);
  });
});

describe('telegram login verification', () => {
  const BOT_TOKEN = '123456:test-bot-token';
  const now = () => Date.parse('2026-07-28T03:00:00.000Z');

  function sign(fields: Record<string, string>): Record<string, string> {
    const checkString = Object.keys(fields)
      .sort()
      .map((key) => `${key}=${fields[key]}`)
      .join('\n');
    const secret = createHash('sha256').update(BOT_TOKEN).digest();
    return { ...fields, hash: createHmac('sha256', secret).update(checkString).digest('hex') };
  }

  const fresh = { id: '99', first_name: 'Ada', auth_date: String(Math.floor(now() / 1000)) };

  it('accepts a freshly signed payload', () => {
    const payload = sign(fresh);
    expect(verifyTelegramLogin(payload, BOT_TOKEN, 300, now).id).toBe('99');
  });

  it('rejects a payload signed by a different bot', () => {
    const payload = sign(fresh);
    expect(() => verifyTelegramLogin(payload, 'other-token', 300, now)).toThrow(
      /telegram_signature_invalid/
    );
  });

  it('rejects a tampered user id even though the hash is well formed', () => {
    const payload = { ...sign(fresh), id: '1' };
    expect(() => verifyTelegramLogin(payload, BOT_TOKEN, 300, now)).toThrow(
      /telegram_signature_invalid/
    );
  });

  it('rejects a replayed payload that is older than the window', () => {
    const stale = sign({ ...fresh, auth_date: String(Math.floor(now() / 1000) - 3600) });
    expect(() => verifyTelegramLogin(stale, BOT_TOKEN, 300, now)).toThrow(
      /telegram_payload_expired/
    );
  });
});
