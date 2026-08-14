import { z } from 'zod';
import { DAILY_BUDGET_UNITS, MAX_CONCURRENT, RATE_LIMIT_RPM } from './limit-bounds.js';

/**
 * One definition of what a plan may contain, shared by the admin console route
 * and the operator CLI.
 *
 * Both writers reach the same `upsertPlan`, and `applyPlanLimits` copies plan
 * values straight into `tenant_limits`, so an unbounded writer does not merely
 * store an odd row: it sets the concurrency and rate limits the request path
 * enforces. When only the console validated, `plan:upsert --max-concurrent 5000`
 * was accepted and became real enforcement state.
 *
 * Every numeric field is `finite()` before it is `int()`. `z.number()` already
 * rejects NaN and `int()` already rejects ±Infinity, so the clause changes no
 * accepted input; it states the invariant the SQLite columns depend on where a
 * reader looks for it, instead of leaving it a side effect of two other rules.
 *
 * The three bounds that `tenant_limits` enforces come from `limit-bounds.ts`
 * rather than being written out here, because the admin limits route and the
 * browser form check the same numbers. The remaining bounds are plan-shaped, not
 * limit-shaped, so they stay literal.
 */
export const planInputSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{2,32}$/),
    name: z.string().min(1).max(64),
    monthlyPriceCents: z.number().finite().int().min(0).max(10_000_00),
    includedTokens: z.number().finite().int().min(0).max(1_000_000_000_000),
    overageCentsPerMillion: z.number().finite().int().min(0).max(1_000_00),
    maxConcurrent: z.number().finite().int().min(MAX_CONCURRENT.min).max(MAX_CONCURRENT.max),
    rateLimitRpm: z.number().finite().int().min(RATE_LIMIT_RPM.min).max(RATE_LIMIT_RPM.max),
    dailyBudgetUnits: z
      .number()
      .finite()
      .int()
      .min(DAILY_BUDGET_UNITS.min)
      .max(DAILY_BUDGET_UNITS.max),
    models: z.array(z.string().min(1).max(64)),
    active: z.boolean().optional(),
    // Release 2 (spec 20.1): subscription purchase metadata. Optional so the
    // operator CLI and older clients keep working; `upsertPlan` applies the
    // same defaults a missing field would otherwise rely on.
    priceCents: z.number().finite().int().min(0).max(1_000_000_000).optional(),
    durationHours: z.number().finite().int().min(1).max(8_760).nullable().optional(),
    timerBasis: z.enum(['from_payment', 'from_first_use']).optional(),
    resetsAllowed: z.number().finite().int().min(0).max(52).optional(),
    method: z.enum(['rolling_time', 'token_pack', 'monetary_pack', 'payg']).optional(),
    tierLabel: z.string().max(32).optional()
  })
  .strict();

export type PlanInput = z.infer<typeof planInputSchema>;
