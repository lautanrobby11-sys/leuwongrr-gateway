// Bounds mirror the server envelope that actually rejects the request:
// planInputSchema in src/billing/plan-input.ts and limitsSchema in
// src/http/console.ts. Keeping them here lets the form refuse a value before it
// becomes a 400, and lets the predicate be tested without rendering the page.
//
// dailyBudgetUnits = 0 is deliberately legal: the field's hint documents it as
// "blocks the tenant for the rest of the day", so it is a real operating value.
export const MAX_DAILY_BUDGET_UNITS = 1_000_000_000_000;
export const MAX_CONCURRENT = 64;
export const MAX_RATE_LIMIT_RPM = 100_000;

export interface TenantLimitsInput {
  dailyBudgetUnits: number;
  maxConcurrent: number;
  rateLimitRpm: number;
}

/**
 * True when the Save button must stay disabled.
 *
 * A cleared or non-numeric number input yields NaN, and NaN fails every
 * comparison below, so a range check alone left the button enabled and the
 * request was rejected with a 400.
 */
export function limitsSaveDisabled(limits: TenantLimitsInput): boolean {
  return (
    !Number.isInteger(limits.dailyBudgetUnits) ||
    !Number.isInteger(limits.maxConcurrent) ||
    !Number.isInteger(limits.rateLimitRpm) ||
    limits.dailyBudgetUnits < 0 ||
    limits.dailyBudgetUnits > MAX_DAILY_BUDGET_UNITS ||
    limits.maxConcurrent < 1 ||
    limits.maxConcurrent > MAX_CONCURRENT ||
    limits.rateLimitRpm < 1 ||
    limits.rateLimitRpm > MAX_RATE_LIMIT_RPM
  );
}
