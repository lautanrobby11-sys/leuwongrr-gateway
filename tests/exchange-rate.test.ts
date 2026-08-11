import { describe, expect, it } from 'vitest';
import { getExchangeRate, idrToTokens, setExchangeRate } from '../src/billing/exchange-rate.js';
import { createTempDatabase } from './support/harness.js';

describe('exchange rate', () => {
  it('converts IDR to tokens at 2 cents per million tokens', () => {
    // Base: 50,000,000 tokens per USD
    expect(idrToTokens(16000, 16000)).toBe(50_000_000);
    expect(idrToTokens(50000, 16000)).toBe(156_250_000);
    expect(idrToTokens(10000, 16000)).toBe(31_250_000);
    expect(idrToTokens(0, 16000)).toBe(0);
  });

  it('rounds down to whole tokens', () => {
    // 16001 IDR: 16001 * 50_000_000 / 16000 = 50003125 exactly? No: 16001*50000000/16000 = 50003125. 16000 IDR = 50M, so 16001 = 50M + 3125
    expect(idrToTokens(16001, 16000)).toBe(50_003_125);
  });

  it('throws when the rate is not configured', () => {
    const { db, dispose } = createTempDatabase();
    try {
      expect(() => getExchangeRate(db.db)).toThrowError(/exchange_rate_not_configured/);
    } finally {
      dispose();
    }
  });

  it('writes and reads back the singleton rate', () => {
    const { db, dispose } = createTempDatabase();
    try {
      setExchangeRate(db.db, 16_000, null);
      expect(getExchangeRate(db.db)).toBe(16_000);
      setExchangeRate(db.db, 16_500, null);
      expect(getExchangeRate(db.db)).toBe(16_500);
    } finally {
      dispose();
    }
  });
});
