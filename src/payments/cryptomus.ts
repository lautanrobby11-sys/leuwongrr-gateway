import { createHash, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';
import { assertPublicEgress } from '../policy/egress.js';

export class PaymentError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number
  ) {
    super(code);
    this.name = 'PaymentError';
  }
}

export interface InvoiceRequest {
  orderId: string;
  amountCents: number;
  currency: string;
  callbackUrl: string;
  returnUrl: string;
  lifetimeSeconds?: number;
}

export interface InvoiceResult {
  uuid: string;
  status: string;
  paymentUrl: string;
}

/**
 * Cryptomus signs the JSON body the way PHP encodes it, which escapes forward
 * slashes. Signing our own payload therefore has to mirror that encoding, and
 * verification accepts either form so a change on their side does not silently
 * reject every webhook.
 */
function phpJson(value: unknown): string {
  return JSON.stringify(value).replace(/\//g, '\\/');
}

export function signPayload(body: string, apiKey: string): string {
  return createHash('md5')
    .update(Buffer.from(body, 'utf8').toString('base64') + apiKey)
    .digest('hex');
}

function constantEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The webhook carries its own signature inside the body, so `sign` is removed before hashing. */
export function verifyWebhookSignature(
  payload: Record<string, unknown>,
  apiKey: string
): boolean {
  const provided = payload.sign;
  if (typeof provided !== 'string' || provided.length !== 32) return false;
  const { sign: _ignored, ...rest } = payload;
  void _ignored;
  const candidates = [phpJson(rest), JSON.stringify(rest)];
  return candidates.some((body) => constantEquals(signPayload(body, apiKey), provided));
}

export class CryptomusClient {
  constructor(
    private readonly config: Config,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  get configured(): boolean {
    return Boolean(this.config.CRYPTOMUS_MERCHANT_ID && this.config.CRYPTOMUS_PAYMENT_API_KEY);
  }

  private credentials(): { merchant: string; apiKey: string } {
    if (!this.config.CRYPTOMUS_MERCHANT_ID || !this.config.CRYPTOMUS_PAYMENT_API_KEY) {
      throw new PaymentError('payments_not_configured', 503);
    }
    return {
      merchant: this.config.CRYPTOMUS_MERCHANT_ID,
      apiKey: this.config.CRYPTOMUS_PAYMENT_API_KEY
    };
  }

  async createInvoice(request: InvoiceRequest): Promise<InvoiceResult> {
    const { merchant, apiKey } = this.credentials();
    const payload = {
      amount: (request.amountCents / 100).toFixed(2),
      currency: request.currency,
      order_id: request.orderId,
      url_callback: request.callbackUrl,
      url_return: request.returnUrl,
      lifetime: request.lifetimeSeconds ?? 3600,
      is_payment_multiple: false
    };
    const body = phpJson(payload);
    const url = assertPublicEgress(new URL('/v1/payment', this.config.CRYPTOMUS_API_URL).toString());

    const response = await this.fetcher(url, {
      method: 'POST',
      headers: {
        merchant,
        sign: signPayload(body, apiKey),
        'content-type': 'application/json'
      },
      body,
      signal: AbortSignal.timeout(this.config.CRYPTOMUS_TIMEOUT_MS)
    });
    if (!response.ok) throw new PaymentError('invoice_create_failed', 502);
    const parsed = (await response.json()) as {
      state?: number;
      result?: { uuid?: string; status?: string; url?: string };
    };
    const result = parsed.result;
    if (parsed.state !== 0 || !result?.uuid || !result.url) {
      throw new PaymentError('invoice_create_rejected', 502);
    }
    return { uuid: result.uuid, status: result.status ?? 'check', paymentUrl: result.url };
  }

  verifyWebhook(payload: Record<string, unknown>): boolean {
    const { apiKey } = this.credentials();
    return verifyWebhookSignature(payload, apiKey);
  }
}

/** Statuses Cryptomus treats as money actually received. */
export const PAID_STATUSES = Object.freeze(['paid', 'paid_over']);
export const FAILED_STATUSES = Object.freeze(['cancel', 'fail', 'system_fail', 'wrong_amount']);
