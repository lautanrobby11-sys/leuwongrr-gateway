import { z } from 'zod';

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
 */
export const planInputSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{2,32}$/),
    name: z.string().min(1).max(64),
    monthlyPriceCents: z.number().finite().int().min(0).max(10_000_00),
    includedTokens: z.number().finite().int().min(0).max(1_000_000_000_000),
    overageCentsPerMillion: z.number().finite().int().min(0).max(1_000_00),
    maxConcurrent: z.number().finite().int().min(1).max(64),
    rateLimitRpm: z.number().finite().int().min(1).max(100000),
    dailyBudgetUnits: z.number().finite().int().min(0).max(1_000_000_000_000),
    models: z.array(z.string().min(1).max(64)),
    active: z.boolean().optional()
  })
  .strict();

export type PlanInput = z.infer<typeof planInputSchema>;
