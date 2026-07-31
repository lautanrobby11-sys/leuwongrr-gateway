import { DAILY_BUDGET_UNITS, MAX_CONCURRENT, RATE_LIMIT_RPM } from '../../../src/billing/limit-bounds.js';

// The bounds are imported, not restated. They live in src/billing/limit-bounds.ts
// because that is the envelope the server actually rejects against —
// planInputSchema and limitsSchema read the same module. A copy here is how the
// form came to allow a dailyBudgetUnits the route answers with a 400.
//
// limit-bounds.ts deliberately carries no dependency, so pulling it into the
// browser bundle costs three frozen objects and no validator.
//
// dailyBudgetUnits = 0 is legal: the field's hint documents it as "blocks the
// tenant for the rest of the day", so it is a real operating value, which is why
// the check below is `< DAILY_BUDGET_UNITS.min` and not `<= 0`.
export { DAILY_BUDGET_UNITS, MAX_CONCURRENT, RATE_LIMIT_RPM };

export interface TenantLimitsInput {
  dailyBudgetUnits: number;
  maxConcurrent: number;
  rateLimitRpm: number;
}

/**
 * Reads a number input without inventing a value the operator never typed.
 *
 * `Number('')` is `0`, not `NaN`, so converting a cleared field with `Number`
 * turned an empty box into a legal daily budget of zero, which quarantines the
 * tenant for the rest of the day. `limitsSaveDisabled` cannot catch that: by the
 * time it runs, the cleared field is already a valid number. Blank input is
 * therefore mapped to `NaN` here, at the boundary, so the invalid state reaches
 * the predicate intact.
 *
 * Anything else is left to `Number`, so `'abc'` stays `NaN` and `'1.5'` stays
 * fractional and is rejected by the integer check rather than silently rounded.
 */
export function parseLimitInput(raw: string): number {
  return raw.trim() === '' ? Number.NaN : Number(raw);
}

/**
 * Renders a limit back into the input box.
 *
 * A controlled `<input type="number">` bound to `NaN` renders the literal string
 * `NaN`, so the cleared field would repopulate itself with a word the operator
 * has to delete before typing. An empty string keeps the box empty and keeps the
 * component controlled.
 */
export function formatLimitInput(value: number): string {
  return Number.isNaN(value) ? '' : String(value);
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
    limits.dailyBudgetUnits < DAILY_BUDGET_UNITS.min ||
    limits.dailyBudgetUnits > DAILY_BUDGET_UNITS.max ||
    limits.maxConcurrent < MAX_CONCURRENT.min ||
    limits.maxConcurrent > MAX_CONCURRENT.max ||
    limits.rateLimitRpm < RATE_LIMIT_RPM.min ||
    limits.rateLimitRpm > RATE_LIMIT_RPM.max
  );
}
