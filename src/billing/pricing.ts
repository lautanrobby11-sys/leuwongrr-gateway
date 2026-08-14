export function effectiveCents(baseCents: number, multiplierBps: number): number {
  if (!Number.isSafeInteger(baseCents) || baseCents < 0) throw new Error('invalid_base_price');
  if (!Number.isSafeInteger(multiplierBps) || multiplierBps < 0) throw new Error('invalid_multiplier');
  return Math.ceil((baseCents * multiplierBps) / 10_000);
}
