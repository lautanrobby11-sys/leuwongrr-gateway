import { TokenBucketLimiter, type RateLimitDecision } from './rate-limit.js';

/**
 * Per-tenant fairness.
 *
 * The credential limiter only protects a single API key, and the source
 * limiter sees the loopback address of the tunnel. Neither of them stops one
 * tenant from consuming the whole host with many keys, so tenant identity gets
 * its own bucket registry. The registry is bounded and evicts least recently
 * used tenants, because the gateway shares a small VPS with OmniRoute.
 */
export class TenantRateLimiterRegistry {
  private readonly limiters = new Map<string, { limiter: TokenBucketLimiter; rpm: number }>();

  constructor(
    private readonly maxTenants: number,
    private readonly burstCeiling: number,
    private readonly now: () => number = () => Date.now()
  ) {
    if (maxTenants <= 0) throw new Error('maxTenants must be positive');
    if (burstCeiling <= 0) throw new Error('burstCeiling must be positive');
  }

  get size(): number {
    return this.limiters.size;
  }

  consume(tenantId: string, ratePerMinute: number): RateLimitDecision {
    const rpm = Math.max(1, Math.floor(ratePerMinute));
    let entry = this.limiters.get(tenantId);

    // A limit change must take effect without a restart.
    if (entry && entry.rpm !== rpm) {
      this.limiters.delete(tenantId);
      entry = undefined;
    }

    if (entry) {
      this.limiters.delete(tenantId);
    } else {
      while (this.limiters.size >= this.maxTenants) {
        const oldest = this.limiters.keys().next();
        if (oldest.done) break;
        this.limiters.delete(oldest.value);
      }
      entry = {
        rpm,
        limiter: new TokenBucketLimiter(
          rpm,
          Math.max(1, Math.min(this.burstCeiling, rpm)),
          1,
          120_000,
          this.now
        )
      };
    }

    this.limiters.set(tenantId, entry);
    return entry.limiter.consume(tenantId);
  }
}

/**
 * Counts in-flight upstream work per tenant. Acquisition never throws so the
 * caller can release its budget reservation and answer with a retryable 503
 * instead of an opaque gateway error.
 */
export class TenantConcurrencyRegistry {
  private readonly active = new Map<string, number>();

  constructor(private readonly maxTenants: number) {
    if (maxTenants <= 0) throw new Error('maxTenants must be positive');
  }

  inUse(tenantId: string): number {
    return this.active.get(tenantId) ?? 0;
  }

  tryAcquire(tenantId: string, limit: number): (() => void) | null {
    const ceiling = Math.max(1, Math.floor(limit));
    const current = this.active.get(tenantId) ?? 0;
    if (current >= ceiling) return null;
    if (current === 0 && this.active.size >= this.maxTenants) return null;

    this.active.set(tenantId, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.active.get(tenantId) ?? 1) - 1;
      if (next <= 0) this.active.delete(tenantId);
      else this.active.set(tenantId, next);
    };
  }
}
