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
 * Every numeric field is `finite()` before any range clause. `z.number()` already
 * rejects NaN; token counts and budgets are additionally `int()` because the
 * request path reads them as whole units, while the two per-million prices keep
 * fractional values because upstream vendors quote them that way ($0.002/1M is a
 * real rate and the INTEGER-affinity column stores it exactly as REAL).
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
    /**
     * Prices per million tokens are legitimately fractional upstream (for
     * example $0.002 per 1M input tokens), so the schema accepts any finite
     * non-negative value instead of whole cents only. The column is INTEGER
     * affinity in SQLite, which stores a fractional value exactly when it can
     * be represented without loss, so the bound here is a magnitude check,
     * not an integer check.
     */
    monthlyPriceCents: z.number().finite().min(0).max(10_000_00),
    includedTokens: z.number().finite().int().min(0).max(1_000_000_000_000),
    overageCentsPerMillion: z.number().finite().min(0).max(1_000_00),
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
    // The model group the plan entitles. Read back from `listPlans` alongside
    // the Release 2 purchase fields, so the console edit form echoes it into
    // this schema on save; without it the strict schema rejected the round-trip
    // with `400 invalid_request` and every plan edit silently failed.
    modelGroupId: z.string().regex(/^[a-z0-9-]{2,32}$/).nullable().optional(),
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
