import { describe, expect, it } from 'vitest';
import { effectiveCents } from '../src/billing/pricing.js';

describe('effective model pricing', () => {
  it('rounds up once at the billing boundary', () => {
    expect(effectiveCents(101, 12500)).toBe(127);
  });

  it('rejects negative prices and multipliers', () => {
    expect(() => effectiveCents(-1, 10000)).toThrow('invalid_base_price');
    expect(() => effectiveCents(1, -1)).toThrow('invalid_multiplier');
  });
});
