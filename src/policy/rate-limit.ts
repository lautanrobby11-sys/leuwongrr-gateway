export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Memory-bounded token bucket limiter.
 *
 * The gateway runs on a small VPS shared with OmniRoute, so the limiter must
 * never grow without bound. Entries are kept in least-recently-used order.
 * Active buckets are never evicted to admit a new key because that would reset
 * both the victim and the newly admitted caller to a full burst.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly refillPerMs: number;

  constructor(
    ratePerMinute: number,
    private readonly burst: number,
    private readonly maxEntries: number,
    private readonly idleEvictionMs = 120_000,
    private readonly now: () => number = () => Date.now()
  ) {
    if (ratePerMinute <= 0) throw new Error('ratePerMinute must be positive');
    if (burst <= 0) throw new Error('burst must be positive');
    if (maxEntries <= 0) throw new Error('maxEntries must be positive');
    this.refillPerMs = ratePerMinute / 60_000;
  }

  get size(): number {
    return this.buckets.size;
  }

  consume(key: string): RateLimitDecision {
    const now = this.now();
    const existing = this.buckets.get(key);
    let bucket: Bucket;

    if (existing) {
      this.buckets.delete(key);
      const elapsed = Math.max(0, now - existing.updatedAt);
      bucket = {
        tokens: Math.min(this.burst, existing.tokens + elapsed * this.refillPerMs),
        updatedAt: now
      };
    } else {
      this.evictIdle(now);
      if (this.buckets.size >= this.maxEntries) {
        return { allowed: false, retryAfterSeconds: this.capacityRetryAfter(now) };
      }
      bucket = { tokens: this.burst, updatedAt: now };
    }

    let allowed = false;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      allowed = true;
    }
    this.buckets.set(key, bucket);

    if (allowed) return { allowed: true, retryAfterSeconds: 0 };
    const missingTokens = 1 - bucket.tokens;
    const waitMs = missingTokens / this.refillPerMs;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
  }

  private evictIdle(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > this.idleEvictionMs) this.buckets.delete(key);
    }
  }

  private capacityRetryAfter(now: number): number {
    const oldest = this.buckets.values().next();
    if (oldest.done) return 1;
    const waitMs = Math.max(1000, this.idleEvictionMs - Math.max(0, now - oldest.value.updatedAt));
    return Math.ceil(waitMs / 1000);
  }
}

export class RateLimitError extends Error {
  readonly statusCode = 429;
  readonly code = 'rate_limited';

  constructor(readonly retryAfterSeconds: number) {
    super('rate_limited');
  }
}
