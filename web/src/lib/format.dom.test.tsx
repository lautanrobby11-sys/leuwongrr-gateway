import { describe, expect, it } from 'vitest';
import { cachePercent, duration, moneyPrecise, tokensPerSecond } from './format';

/**
 * The member usage ledger derives throughput, cache ratio, sub-cent cost, and
 * duration entirely from these helpers, so their edge cases are the contract:
 * a missing split must read as a dash, never a fabricated zero, and a cheap
 * request must not round down to "$0.00" and look free.
 */
describe('moneyPrecise', () => {
  it('keeps four decimals for sub-cent estimates so a cheap call is not shown as free', () => {
    expect(moneyPrecise(0.02)).toBe('$0.0002');
    expect(moneyPrecise(0.5)).toBe('$0.005');
  });

  it('uses ordinary two-decimal currency at or above one cent', () => {
    expect(moneyPrecise(1)).toBe('$0.01');
    expect(moneyPrecise(150)).toBe('$1.50');
  });

  it('renders a dash for null or non-finite input', () => {
    expect(moneyPrecise(null)).toBe('—');
    expect(moneyPrecise(Number.NaN)).toBe('—');
  });
});

describe('tokensPerSecond', () => {
  it('computes throughput from output tokens and duration', () => {
    expect(tokensPerSecond(100, 1000)).toBe('100 tok/s');
    expect(tokensPerSecond(15, 1000)).toBe('15.0 tok/s');
  });

  it('returns a dash when either input is missing or zero', () => {
    expect(tokensPerSecond(null, 1000)).toBe('—');
    expect(tokensPerSecond(100, null)).toBe('—');
    expect(tokensPerSecond(100, 0)).toBe('—');
  });
});

describe('cachePercent', () => {
  it('reports the cached share of input tokens', () => {
    expect(cachePercent(50, 100)).toBe('50%');
    expect(cachePercent(200, 100)).toBe('100%');
  });

  it('returns a dash without a usable denominator', () => {
    expect(cachePercent(null, 100)).toBe('—');
    expect(cachePercent(10, null)).toBe('—');
    expect(cachePercent(10, 0)).toBe('—');
  });
});

describe('duration', () => {
  it('renders milliseconds, seconds, and minutes at the right scale', () => {
    expect(duration(450)).toBe('450 ms');
    expect(duration(2500)).toBe('2.5 s');
    expect(duration(90_000)).toBe('1m 30s');
  });

  it('returns a dash for null or negative input', () => {
    expect(duration(null)).toBe('—');
    expect(duration(-5)).toBe('—');
  });
});
