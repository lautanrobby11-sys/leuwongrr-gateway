import { describe, expect, it } from 'vitest';
import {
  formatLimitInput,
  limitsSaveDisabled,
  parseLimitInput,
  MAX_CONCURRENT,
  MAX_DAILY_BUDGET_UNITS,
  MAX_RATE_LIMIT_RPM
} from '../web/src/admin/limits-validation.js';

/**
 * The admin limits form mirrored every server bound except the daily budget
 * ceiling, so an operator could submit a value the gateway rejects with a 400
 * while the Save button still looked usable.
 *
 * Zero stays legal on purpose: the field's own hint documents it as "blocks the
 * tenant for the rest of the day", so rejecting it would be a regression, not a
 * stricter check. That is also why the form must not manufacture a zero on its
 * own, which is what the parseLimitInput cases below defend.
 */

const valid = { dailyBudgetUnits: 100_000, maxConcurrent: 2, rateLimitRpm: 120 };

describe('limitsSaveDisabled', () => {
  it('enables Save for in-range values', () => {
    expect(limitsSaveDisabled(valid)).toBe(false);
  });

  it('keeps dailyBudgetUnits = 0 legal, because it quarantines the tenant', () => {
    expect(limitsSaveDisabled({ ...valid, dailyBudgetUnits: 0 })).toBe(false);
  });

  it('disables Save above the server maximum', () => {
    expect(
      limitsSaveDisabled({ ...valid, dailyBudgetUnits: MAX_DAILY_BUDGET_UNITS + 1 })
    ).toBe(true);
  });

  it('allows exactly the server maximum', () => {
    expect(
      limitsSaveDisabled({ ...valid, dailyBudgetUnits: MAX_DAILY_BUDGET_UNITS })
    ).toBe(false);
  });

  it('disables Save for a negative budget', () => {
    expect(limitsSaveDisabled({ ...valid, dailyBudgetUnits: -1 })).toBe(true);
  });

  it('disables Save for a cleared, non-integer input', () => {
    expect(limitsSaveDisabled({ ...valid, dailyBudgetUnits: Number.NaN })).toBe(true);
  });

  // The upper bounds on these two were enforced but never asserted, so a later
  // edit could have relaxed either one without a single test turning red.
  const boundedFields = [
    { field: 'maxConcurrent' as const, max: MAX_CONCURRENT },
    { field: 'rateLimitRpm' as const, max: MAX_RATE_LIMIT_RPM }
  ];

  for (const { field, max } of boundedFields) {
    it(`allows exactly the server maximum for ${field}`, () => {
      expect(limitsSaveDisabled({ ...valid, [field]: max })).toBe(false);
    });

    it(`disables Save above the server maximum for ${field}`, () => {
      expect(limitsSaveDisabled({ ...valid, [field]: max + 1 })).toBe(true);
    });

    it(`disables Save below one for ${field}`, () => {
      expect(limitsSaveDisabled({ ...valid, [field]: 0 })).toBe(true);
    });

    it(`disables Save for a fractional ${field}`, () => {
      expect(limitsSaveDisabled({ ...valid, [field]: 1.5 })).toBe(true);
    });
  }
});

/**
 * These cases are the form's own conversion, not the predicate's. The modal
 * reads every limit with parseLimitInput(event.target.value); the previous suite
 * only ever fed the predicate Number.NaN directly, so the one conversion that
 * could fabricate a value - Number('') === 0 - went untested.
 */
describe('parseLimitInput', () => {
  it('does not turn a cleared field into zero', () => {
    expect(parseLimitInput('')).toBeNaN();
    expect(Number('')).toBe(0);
  });

  it('does not turn a whitespace-only field into zero', () => {
    expect(parseLimitInput('   ')).toBeNaN();
  });

  it('keeps a cleared field from enabling Save', () => {
    expect(
      limitsSaveDisabled({ ...valid, dailyBudgetUnits: parseLimitInput('') })
    ).toBe(true);
  });

  it('keeps a typed zero, which is a real operating value', () => {
    expect(parseLimitInput('0')).toBe(0);
    expect(limitsSaveDisabled({ ...valid, dailyBudgetUnits: parseLimitInput('0') })).toBe(
      false
    );
  });

  it('passes ordinary values through unchanged', () => {
    expect(parseLimitInput('100000')).toBe(100_000);
  });

  it('leaves non-numeric text invalid rather than zero', () => {
    expect(parseLimitInput('abc')).toBeNaN();
  });

  it('leaves a fractional value fractional so the integer check rejects it', () => {
    expect(parseLimitInput('1.5')).toBe(1.5);
    expect(limitsSaveDisabled({ ...valid, dailyBudgetUnits: parseLimitInput('1.5') })).toBe(
      true
    );
  });
});

describe('formatLimitInput', () => {
  it('renders a cleared field as an empty box, not the word NaN', () => {
    expect(formatLimitInput(Number.NaN)).toBe('');
    expect(String(Number.NaN)).toBe('NaN');
  });

  it('renders zero, so a quarantined tenant does not look like an empty field', () => {
    expect(formatLimitInput(0)).toBe('0');
  });

  it('renders ordinary values unchanged', () => {
    expect(formatLimitInput(100_000)).toBe('100000');
  });
});
