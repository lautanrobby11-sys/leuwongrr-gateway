import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, jsonResponse } from './support/harness.js';
import type { Scope } from '../src/auth/api-keys.js';

let harness: Awaited<ReturnType<typeof createHarness>> | null = null;

afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
});

function keyFor(tenant: string, scopes: Scope[]): string {
  return harness!.db.tenants.issue({ tenantId: tenant, name: 'overhead-test', scopes }).plaintext;
}

/**
 * Issue #47: the reservation estimate did not include upstream context
 * overhead (measured 2209 units on a one-word prompt), so the first request of
 * a day could silently exceed a small daily budget. The estimate must include
 * a configured overhead term on every metered path.
 */
describe('budget reservation includes upstream context overhead (#47)', () => {
  it('rejects the first request when estimate + overhead exceeds the daily limit', async () => {
    // max_tokens=4 keeps the token estimate tiny (~15 units). With the
    // configured overhead of 2200 the reservation exceeds DAILY_BUDGET_UNITS=100
    // and must be refused 402 before upstream is called - closing the 89.4x gap
    // measured in production where the one-word prompt settled 2234 units.
    harness = createHarness(jsonResponse, {
      DAILY_BUDGET_UNITS: 100,
      UPSTREAM_CONTEXT_OVERHEAD_UNITS: 2200
    });
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${harness.token}` },
      payload: {
        model: 'lwrr-text',
        max_tokens: 4,
        messages: [{ role: 'user', content: 'ping' }]
      }
    });
    expect(res.statusCode).toBe(402);
    expect(JSON.parse(res.body).error?.code).toBe('budget_exceeded');
    expect(harness.upstreamCalls()).toBe(0);
  });

  it('still allows the request when estimate + overhead fits, and settles the real usage', async () => {
    harness = createHarness(
      () =>
        new Response(
          JSON.stringify({ id: 'chatcmpl_mock', usage: { total_tokens: 2234 } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
      { DAILY_BUDGET_UNITS: 5000, UPSTREAM_CONTEXT_OVERHEAD_UNITS: 2200 }
    );
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${harness.token}` },
      payload: {
        model: 'lwrr-text',
        max_tokens: 4,
        messages: [{ role: 'user', content: 'ping' }]
      }
    });
    expect(res.statusCode).toBe(200);
    // The settled row carries the real reported usage, not the estimate.
    const row = harness.db.db
      .prepare(
        "SELECT units FROM usage_events WHERE tenant_id='tenant-a' AND state='settled' ORDER BY rowid DESC LIMIT 1"
      )
      .get() as { units: number } | undefined;
    expect(row?.units).toBe(2234);
  });

  it('reserves estimate + overhead on the streaming path', async () => {
    harness = createHarness(jsonResponse, {
      DAILY_BUDGET_UNITS: 5000,
      UPSTREAM_CONTEXT_OVERHEAD_UNITS: 2200
    });
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${harness.token}` },
      payload: {
        model: 'lwrr-text',
        stream: true,
        max_tokens: 4,
        messages: [{ role: 'user', content: 'ping' }]
      }
    });
    expect(res.statusCode).toBe(200);
    // Stream with no usage reported falls back to the estimate, which must
    // include the overhead term - never below 2200.
    const row = harness.db.db
      .prepare(
        "SELECT units FROM usage_events WHERE tenant_id='tenant-a' AND state='settled' ORDER BY rowid DESC LIMIT 1"
      )
      .get() as { units: number } | undefined;
    expect(row?.units).toBeGreaterThanOrEqual(2200);
  });

  it('reserves estimate + overhead on the responses path', async () => {
    harness = createHarness(jsonResponse, {
      DAILY_BUDGET_UNITS: 5000,
      UPSTREAM_CONTEXT_OVERHEAD_UNITS: 2200
    });
    const responsesToken = keyFor('tenant-a', ['responses:write']);
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: `Bearer ${responsesToken}` },
      payload: { model: 'lwrr-text', max_output_tokens: 4, input: 'ping' }
    });
    expect(res.statusCode).toBe(200);
    const row = harness.db.db
      .prepare(
        "SELECT units FROM usage_events WHERE tenant_id='tenant-a' AND state='settled' ORDER BY rowid DESC LIMIT 1"
      )
      .get() as { units: number } | undefined;
    expect(row?.units).toBeGreaterThanOrEqual(2200);
  });
});
