import { describe, expect, it } from 'vitest';
import {
  limitsSaveDisabled,
  DAILY_BUDGET_UNITS,
  MAX_CONCURRENT,
  RATE_LIMIT_RPM
} from '../web/src/admin/limits-validation.js';
import { planInputSchema } from '../src/billing/plan-input.js';

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

const bounds = [
  { field: 'dailyBudgetUnits', bound: DAILY_BUDGET_UNITS },
  { field: 'maxConcurrent', bound: MAX_CONCURRENT },
  { field: 'rateLimitRpm', bound: RATE_LIMIT_RPM }
] as const;

describe('limitsSaveDisabled', () => {
  it('enables Save for in-range values', () => {
    expect(limitsSaveDisabled(valid)).toBe(false);
  });

  it('keeps dailyBudgetUnits = 0 legal, because it quarantines the tenant', () => {
    expect(limitsSaveDisabled({ ...valid, dailyBudgetUnits: 0 })).toBe(false);
  });

  // Table-driven across all three fields: the daily budget was the field that
  // actually shipped unbounded, but a per-field test is what keeps the next
  // bound change from reintroducing the same class of gap on a different field.
  it.each(bounds)('allows exactly the maximum for $field', ({ field, bound }) => {
    expect(limitsSaveDisabled({ ...valid, [field]: bound.max })).toBe(false);
  });

  it.each(bounds)('disables Save above the maximum for $field', ({ field, bound }) => {
    expect(limitsSaveDisabled({ ...valid, [field]: bound.max + 1 })).toBe(true);
  });

  it.each(bounds)('allows exactly the minimum for $field', ({ field, bound }) => {
    expect(limitsSaveDisabled({ ...valid, [field]: bound.min })).toBe(false);
  });

  it.each(bounds)('disables Save below the minimum for $field', ({ field, bound }) => {
    expect(limitsSaveDisabled({ ...valid, [field]: bound.min - 1 })).toBe(true);
  });

  it.each(bounds)('disables Save for a cleared, non-integer $field', ({ field }) => {
    expect(limitsSaveDisabled({ ...valid, [field]: Number.NaN })).toBe(true);
  });

  it.each(bounds)('disables Save for a fractional $field', ({ field, bound }) => {
    expect(limitsSaveDisabled({ ...valid, [field]: bound.min + 0.5 })).toBe(true);
  });
});

/**
 * The point of a shared bounds module is that the form and the route cannot
 * drift. Asserting the constants alone would not prove that: the form could
 * import them and the schema could still carry its own literals. So the schema
 * itself is driven, at each boundary value, and asked to agree with the
 * predicate.
 */
describe('browser bounds agree with the server schema', () => {
  const plan = {
    id: 'bounds-probe',
    name: 'Bounds probe',
    monthlyPriceCents: 0,
    includedTokens: 0,
    overageCentsPerMillion: 0,
    models: ['gpt-4o-mini'],
    ...valid
  };

  it.each(bounds)('$field: the schema accepts min and max', ({ field, bound }) => {
    expect(planInputSchema.safeParse({ ...plan, [field]: bound.min }).success).toBe(true);
    expect(planInputSchema.safeParse({ ...plan, [field]: bound.max }).success).toBe(true);
  });

  it.each(bounds)('$field: the schema rejects just outside min and max', ({ field, bound }) => {
    expect(planInputSchema.safeParse({ ...plan, [field]: bound.min - 1 }).success).toBe(false);
    expect(planInputSchema.safeParse({ ...plan, [field]: bound.max + 1 }).success).toBe(false);
  });

  it.each(bounds)('$field: Save is enabled exactly when the schema accepts', ({ field, bound }) => {
    for (const value of [bound.min - 1, bound.min, bound.max, bound.max + 1]) {
      const accepted = planInputSchema.safeParse({ ...plan, [field]: value }).success;
      expect(limitsSaveDisabled({ ...valid, [field]: value })).toBe(!accepted);
    }
  });
});
