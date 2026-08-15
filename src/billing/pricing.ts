/**
 * The multiplier is a markup on the vendor rate, quoted per million tokens.
 * Vendors legitimately price below a whole cent ($0.002/1M), so the input is
 * any finite non-negative value and the result is rounded up to the nearest
 * 0.0001 cent: rounding up keeps the quoted price from ever undercutting the
 * effective rate, and four decimals keep a sub-cent rate honest instead of
 * inflating $0.002/1M to a full cent.
 */
export function effectiveCents(baseCents: number, multiplierBps: number): number {
  if (!Number.isFinite(baseCents) || baseCents < 0) throw new Error('invalid_base_price');
  if (!Number.isSafeInteger(multiplierBps) || multiplierBps < 0) throw new Error('invalid_multiplier');
  return Math.ceil(((baseCents * multiplierBps) / 10_000) * 10_000) / 10_000;
}

/**
 * Custom token top-up pricing. A member may buy any quantity of plan tokens on
 * its own schedule; the rate applied is the plan's pay-as-you-go rate plus
 * 5% (five percent), charged per whole million tokens bought. The surcharge is
 * rounded up so the invoice never undercuts the rate: 1M tokens at a 200-cent
 * plan rate costs exactly 210 cents, never 209.999 rounded down. The result
 * is returned in whole cents because invoices are settled in cents.
 */
export function customTokenCents(overageCentsPerMillion: number, tokens: number): number {
  if (!Number.isFinite(overageCentsPerMillion) || overageCentsPerMillion <= 0) throw new Error('invalid_overage_rate');
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('invalid_token_quantity');
  return Math.ceil((tokens / 1_000_000) * overageCentsPerMillion * 1.05);
}
