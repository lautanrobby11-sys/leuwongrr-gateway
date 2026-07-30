import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, jsonResponse, seedTenant, type Harness } from './support/harness.js';

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
});

const METRICS_TOKEN = 'm'.repeat(32);

function withMetrics(): Harness {
  harness = createHarness(jsonResponse, {
    METRICS_ENABLED: true,
    INTERNAL_METRICS_TOKEN: METRICS_TOKEN
  });
  return harness;
}

/** Lets the onResponse hook record the sample before the scrape reads it. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('metrics exposure', () => {
  it('denies its own existence without the internal token', async () => {
    const active = withMetrics();
    expect((await active.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
    const wrong = await active.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-internal-metrics-token': 'n'.repeat(32) }
    });
    expect(wrong.statusCode).toBe(404);
  });

  it('stays shut when the operator never enabled it', async () => {
    harness = createHarness(jsonResponse);
    const response = await harness.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-internal-metrics-token': METRICS_TOKEN }
    });
    expect(response.statusCode).toBe(404);
  });

  it('reports route level series and nothing that identifies a caller', async () => {
    const active = withMetrics();
    const models = await active.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${active.token}` }
    });
    expect(models.statusCode).toBe(200);
    await settle();

    const scrape = await active.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-internal-metrics-token': METRICS_TOKEN }
    });
    expect(scrape.statusCode).toBe(200);
    expect(scrape.body).toContain('leuwongrr_requests_total{route="models.list",status="2xx"} 1');
    expect(scrape.body).toContain('leuwongrr_request_duration_ms_count{route="models.list"} 1');
    expect(scrape.body).not.toContain('tenant-a');
    expect(scrape.body).not.toContain(active.token);
  });
});

describe('console origin enforcement', () => {
  /**
   * The origin rule only exists where console routes are registered. The default
   * fixture keeps `CONSOLE_ENABLED: false`, which now answers every console path
   * with `404 route_not_found` instead of falling through to the shared hook, so
   * these cases must opt the console in to be about origin at all.
   */
  function withConsole(): Harness {
    harness = createHarness(jsonResponse, { CONSOLE_ENABLED: true });
    return harness;
  }

  it('refuses a state change that carries no origin at all', async () => {
    const active = withConsole();
    const response = await active.app.inject({
      method: 'POST',
      url: '/console/api/auth/request-code',
      payload: { email: 'member@example.com' }
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('origin_rejected');
  });

  it('refuses a state change driven from another site', async () => {
    const active = withConsole();
    const response = await active.app.inject({
      method: 'POST',
      url: '/console/api/member/topup',
      headers: { origin: 'https://evil.example.com' },
      payload: { amount: 10 }
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('origin_rejected');
  });

  it('admits the configured console origin', async () => {
    const active = withConsole();
    const response = await active.app.inject({
      method: 'POST',
      url: '/console/api/auth/request-code',
      headers: { origin: 'http://127.0.0.1:2080' },
      payload: { email: 'member@example.com' }
    });
    expect(response.statusCode).not.toBe(403);
  });

  it('leaves reads alone, since they change nothing', async () => {
    const active = withConsole();
    const response = await active.app.inject({ method: 'GET', url: '/console/api/session' });
    expect(response.statusCode).not.toBe(403);
  });

  it('leaves signed third party callbacks alone', async () => {
    const active = withConsole();
    const response = await active.app.inject({
      method: 'POST',
      url: '/webhooks/cryptomus',
      payload: { sign: 'unverified' }
    });
    expect(response.statusCode).not.toBe(403);
  });
});

describe('entitlement isolation between tenants', () => {
  it('keeps a tenant away from a model it was never granted', async () => {
    harness = createHarness(jsonResponse);
    const other = seedTenant(harness.db, 'tenant-b', ['models:read', 'chat:write']);

    const models = await harness.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${other}` }
    });
    expect(models.statusCode).toBe(200);
    expect(models.json().data).toHaveLength(0);

    const chat = await harness.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${other}` },
      payload: { model: 'lwrr-text', messages: [{ role: 'user', content: 'hi' }] }
    });
    expect(chat.statusCode).toBe(403);
    expect(chat.body).toContain('model_not_entitled');
    expect(harness.upstreamCalls()).toBe(0);
  });
});
