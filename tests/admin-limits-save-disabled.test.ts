import { describe, expect, it } from 'vitest';
import {
  limitsSaveDisabled,
  MAX_DAILY_BUDGET_UNITS
} from '../web/src/admin/limits-validation.js';

/**
 * The admin limits form mirrored every server bound except the daily budget
 * ceiling, so an operator could submit a value the gateway rejects with a 400
 * while the Save button still looked usable.
 *
 * Zero stays legal on purpose: the field's own hint documents it as "blocks the
 * tenant for the rest of the day", so rejecting it would be a regression, not a
 * stricter check.
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
});
