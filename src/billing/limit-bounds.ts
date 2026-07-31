/**
 * The numeric envelope for tenant limits, defined once.
 *
 * Three writers enforce the same bounds and used to restate them: the operator
 * CLI and admin route through `planInputSchema`, the admin limits route through
 * `limitsSchema`, and the browser form through `limitsSaveDisabled`. When the
 * server bound changes and a copy does not, the UI silently disagrees with the
 * gateway: Save stays enabled for a value the route answers with
 * `400 invalid_request`.
 *
 * This module holds no dependency on purpose. `web/` bundles it into the
 * browser, so importing zod here would drag the validator into the console
 * bundle; keeping it to plain numbers means the same literals cross the
 * boundary without the schema following them.
 *
 * `DAILY_BUDGET_UNITS.min` is `0`, and that is a real operating value rather
 * than a lower bound nobody reaches: the admin field documents zero as blocking
 * the tenant for the rest of the day.
 */
export interface LimitBound {
  readonly min: number;
  readonly max: number;
}

export const DAILY_BUDGET_UNITS: LimitBound = { min: 0, max: 1_000_000_000_000 };
export const MAX_CONCURRENT: LimitBound = { min: 1, max: 64 };
export const RATE_LIMIT_RPM: LimitBound = { min: 1, max: 100_000 };
