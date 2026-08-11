import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC verification for leuwongrr.online payment webhooks. The sender computes
 * hex(HMAC-SHA256(secret, body)) and sends it in the x-leuwongrr-signature
 * header, optionally prefixed with `sha256=`.
 */
export function verifyHmacSignature(secret: string, body: string, signature: string): boolean {
  const expected = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

/** Statuses leuwongrr.online treats as money actually received. */
export const PAID_STATUSES = Object.freeze(['paid', 'paid_over']);

export function isPaidStatus(status: string): boolean {
  return PAID_STATUSES.includes(status);
}
