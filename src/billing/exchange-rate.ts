import type { Database } from 'better-sqlite3';
import { BillingError } from './service.js';

/**
 * Exchange rate for IDR → USD conversion used by leuwongrr.online payment
 * webhooks. A missing rate is a hard fail: billing must never invent one.
 */

const SINGLETON_ID = 'default';

export function getExchangeRate(db: Database): number {
  const row = db
    .prepare("SELECT idr_per_usd FROM exchange_rates WHERE id = 'default'")
    .get() as { idr_per_usd: number } | undefined;
  if (!row) throw new BillingError('exchange_rate_not_configured', 503);
  return row.idr_per_usd;
}

export function setExchangeRate(db: Database, idrPerUsd: number, updatedBy: string | null): void {
  db.prepare(
    `INSERT INTO exchange_rates (id, idr_per_usd, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET idr_per_usd = excluded.idr_per_usd, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).run(SINGLETON_ID, idrPerUsd, new Date().toISOString(), updatedBy);
}

/**
 * Convert IDR to gateway tokens. Base price: $0.02 per 1M tokens = 2 cents.
 * 1 USD = 50,000,000 tokens. Therefore tokens = floor(amountIdr * 50_000_000 / idrPerUsd).
 */
export function idrToTokens(amountIdr: number, idrPerUsd: number): number {
  if (amountIdr <= 0) return 0;
  return Math.floor(amountIdr * (50_000_000 / idrPerUsd));
}
