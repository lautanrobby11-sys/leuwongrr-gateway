const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const PLAIN = new Intl.NumberFormat('en-US');

export function tokens(value: number): string {
  return value >= 10_000 ? COMPACT.format(value) : PLAIN.format(value);
}

export function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.min(100, Math.round((part / whole) * 100));
}

export function shortDate(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function daysUntil(value: string | null | undefined): number | null {
  if (!value) return null;
  const diff = new Date(value).getTime() - Date.now();
  return diff <= 0 ? 0 : Math.ceil(diff / 86_400_000);
}

/**
 * Cost in whole-cent currency for a value already expressed in cents, kept apart
 * from {@link money} because a usage estimate can be a fraction of a cent
 * ($0.0002). Sub-cent values keep four decimals so a cheap request does not
 * round to $0.00 and read as free.
 */
export function moneyPrecise(cents: number | null): string {
  if (cents === null || !Number.isFinite(cents)) return '—';
  const dollars = cents / 100;
  const digits = dollars !== 0 && Math.abs(dollars) < 0.01 ? 4 : 2;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: digits
  }).format(dollars);
}

/** Throughput in tokens per second, or a dash when either input is missing. */
export function tokensPerSecond(outputTokens: number | null, durationMs: number | null): string {
  if (outputTokens === null || durationMs === null || durationMs <= 0) return '—';
  const perSecond = outputTokens / (durationMs / 1000);
  if (!Number.isFinite(perSecond) || perSecond <= 0) return '—';
  return `${perSecond >= 100 ? Math.round(perSecond) : perSecond.toFixed(1)} tok/s`;
}

/** Cache hit rate against the input tokens, as a whole percent, or a dash. */
export function cachePercent(cachedTokens: number | null, inputTokens: number | null): string {
  if (cachedTokens === null || inputTokens === null || inputTokens <= 0) return '—';
  return `${Math.min(100, Math.round((cachedTokens / inputTokens) * 100))}%`;
}

/** Milliseconds rendered as a compact human duration. */
export function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
