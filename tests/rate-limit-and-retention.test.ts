import { afterEach, describe, expect, it } from 'vitest';
import { TokenBucketLimiter } from '../src/policy/rate-limit.js';
import { createHarness, createTempDatabase, jsonResponse, seedTenant, type Harness } from './support/harness.js';
import type { GatewayDatabase } from '../src/persistence/database.js';

let harness: Harness | null = null;
let dispose: (() => void) | null = null;

afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
  if (dispose) {
    dispose();
    dispose = null;
  }
});

function openDatabase(): GatewayDatabase {
  const created = createTempDatabase();
  dispose = created.dispose;
  return created.db;
}

describe('token bucket limiter', () => {
  it('allows the burst then refuses with a retry hint', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter(60, 2, 16, 120_000, () => now);
    expect(limiter.consume('a').allowed).toBe(true);
    expect(limiter.consume('a').allowed).toBe(true);
    const blocked = limiter.consume('a');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    now += 1000;
    expect(limiter.consume('a').allowed).toBe(true);
  });

  it('isolates callers and bounds memory usage', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter(60, 1, 4, 120_000, () => now);
    expect(limiter.consume('tenant-a').allowed).toBe(true);
    expect(limiter.consume('tenant-b').allowed).toBe(true);
    for (let index = 0; index < 50; index += 1) {
      now += 1000;
      limiter.consume(`caller-${index}`);
    }
    expect(limiter.size).toBeLessThanOrEqual(4);
  });
});

describe('request rate limiting', () => {
  it('returns 429 with retry-after once the credential budget is spent', async () => {
    harness = createHarness(jsonResponse, { RATE_LIMIT_RPM: 60, RATE_LIMIT_BURST: 2 });
    const headers = { authorization: `Bearer ${harness.token}` };
    expect((await harness.app.inject({ method: 'GET', url: '/v1/models', headers })).statusCode).toBe(200);
    expect((await harness.app.inject({ method: 'GET', url: '/v1/models', headers })).statusCode).toBe(200);
    const limited = await harness.app.inject({ method: 'GET', url: '/v1/models', headers });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.json().error.code).toBe('rate_limited');
  });

  it('never rate limits liveness checks', async () => {
    harness = createHarness(jsonResponse, { RATE_LIMIT_RPM: 60, RATE_LIMIT_BURST: 1 });
    for (let index = 0; index < 5; index += 1) {
      expect((await harness.app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    }
  });
});

describe('database retention', () => {
  it('removes expired idempotency claims and aged history', () => {
    const db = openDatabase();
    seedTenant(db, 'tenant-a', ['chat:write']);
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();

    db.db
      .prepare(
        'INSERT INTO idempotency_keys(tenant_id,key,request_hash,status_code,response_json,expires_at) VALUES(?,?,?,?,?,?)'
      )
      .run('tenant-a', 'expired', 'hash', 200, '{}', old);
    db.db
      .prepare(
        "INSERT INTO usage_events(id,tenant_id,request_id,units,state,day,created_at) VALUES(?,?,?,?,'settled',?,?)"
      )
      .run('usage-old', 'tenant-a', 'req-old', 10, old.slice(0, 10), old);
    db.audit('tenant-a', 'llm.request', 'trace-new');

    const result = db.maintain(90);

    expect(result.expiredIdempotencyKeys).toBe(1);
    expect(result.expiredUsageEvents).toBe(1);
    expect(db.db.prepare('SELECT COUNT(*) AS total FROM audit_logs').get()).toEqual({ total: 1 });
  });
});
