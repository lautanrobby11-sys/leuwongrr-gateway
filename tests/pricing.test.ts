import { describe, expect, it } from 'vitest';
import { customTokenCents, effectiveCents } from '../src/billing/pricing.js';

describe('effective model pricing', () => {
  // The multiplier rounds up to the nearest 0.0001 cent, never inflating a rate
  // more than that fraction: 101 * 1.25 = 126.25 exactly, so the result keeps
  // the whole-cent part honest. Under the old whole-cent ceiling the same rate
  // printed 127, overstating the vendor price.
  it('rounds up once at the billing boundary', () => {
    expect(effectiveCents(101, 12500)).toBe(126.25);
  });

  // Vendors quote sub-cent rates ($0.002/1M), so the multiplier must keep a
  // fractional base instead of snapping it to a whole cent. The result is
  // rounded up to the nearest 0.0001 cent so it never undercuts the rate.
  it('keeps fractional per-million rates honest', () => {
    expect(effectiveCents(0.002, 10000)).toBe(0.002);
    expect(effectiveCents(0.002, 12500)).toBe(0.0025);
    expect(effectiveCents(0.0001, 12500)).toBe(0.0002);
  });

  it('rejects negative prices and multipliers', () => {
    expect(() => effectiveCents(-1, 10000)).toThrow('invalid_base_price');
    expect(() => effectiveCents(1, -1)).toThrow('invalid_multiplier');
  });
});

describe('custom token pack pricing', () => {
  it('applies the plan rate plus a 5 per cent markup, rounded up', () => {
    // 1M tokens at 200 cents/M * 1.05 = exactly 210.
    expect(customTokenCents(200, 1_000_000)).toBe(210);
    // 3M tokens at 200 cents/M * 1.05 = exactly 630.
    expect(customTokenCents(200, 3_000_000)).toBe(630);
    // Fractional result rounds up: the invoice never undercuts the rate.
    expect(customTokenCents(127, 1_111_111)).toBe(Math.ceil(1.111111 * 127 * 1.05));
  });

  it('supports fractional per-million rates', () => {
    // 2M tokens at $0.002/1M * 1.05 = 0.0042 cents, rounded up to 1 cent.
    expect(customTokenCents(0.002, 2_000_000)).toBe(1);
  });

  it('rejects a non-positive rate or a non-integer quantity', () => {
    expect(() => customTokenCents(0, 1_000_000)).toThrow('invalid_overage_rate');
    expect(() => customTokenCents(200, 1.5)).toThrow('invalid_token_quantity');
    expect(() => customTokenCents(200, -1)).toThrow('invalid_token_quantity');
  });
});
