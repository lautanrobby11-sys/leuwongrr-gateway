import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, jsonResponse, testConfig, type Harness } from './support/harness.js';
import {
  TenantConcurrencyRegistry,
  TenantRateLimiterRegistry
} from '../src/policy/tenant-limits.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
});

describe('tenant fairness', () => {
  it('meters each tenant separately', () => {
    const registry = new TenantRateLimiterRegistry(16, 30);
    expect(registry.consume('tenant-a', 1).allowed).toBe(true);
    expect(registry.consume('tenant-a', 1).allowed).toBe(false);
    expect(registry.consume('tenant-b', 1).allowed).toBe(true);
  });

  it('applies a changed limit without a restart', () => {
    const registry = new TenantRateLimiterRegistry(16, 30);
    expect(registry.consume('tenant-a', 1).allowed).toBe(true);
    expect(registry.consume('tenant-a', 1).allowed).toBe(false);
    expect(registry.consume('tenant-a', 600).allowed).toBe(true);
  });

  it('stays memory bounded when many tenants appear', () => {
    const registry = new TenantRateLimiterRegistry(2, 30);
    for (const tenant of ['a', 'b', 'c', 'd']) registry.consume(tenant, 60);
    expect(registry.size).toBe(2);
  });

  it('caps in-flight work per tenant and releases a slot exactly once', () => {
    const registry = new TenantConcurrencyRegistry(8);
    const release = registry.tryAcquire('tenant-a', 1);
    expect(release).not.toBeNull();
    expect(registry.tryAcquire('tenant-a', 1)).toBeNull();
    expect(registry.tryAcquire('tenant-b', 1)).not.toBeNull();
    release?.();
    release?.();
    expect(registry.inUse('tenant-a')).toBe(0);
    expect(registry.inUse('tenant-b')).toBe(1);
  });

  it('enforces the provisioned tenant rate limit on the request path', async () => {
    harness = createHarness(jsonResponse);
    const { app, db, token } = harness;
    db.tenants.setLimits('tenant-a', {
      dailyBudgetUnits: 10_000,
      maxConcurrent: 1,
      rateLimitRpm: 1
    });
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: 'GET', url: '/v1/models', headers })).statusCode).toBe(200);
    const limited = await app.inject({ method: 'GET', url: '/v1/models', headers });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });
});

describe('readiness', () => {
  it('reports ready only when the upstream answers', async () => {
    harness = createHarness(jsonResponse);
    const ready = await harness.app.inject({
      method: 'GET',
      url: '/health/ready',
      headers: { 'x-internal-ready-token': testConfig.INTERNAL_READY_TOKEN }
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready' });
  });

  it('fails readiness when the upstream is unhealthy', async () => {
    harness = createHarness(() => new Response('down', { status: 503 }));
    const response = await harness.app.inject({
      method: 'GET',
      url: '/health/ready',
      headers: { 'x-internal-ready-token': testConfig.INTERNAL_READY_TOKEN }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('not_ready');
  });
});
