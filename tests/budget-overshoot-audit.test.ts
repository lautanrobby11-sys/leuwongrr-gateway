import { afterEach, describe, expect, it } from 'vitest';
import { createHarness } from './support/harness.js';

let harness: Awaited<ReturnType<typeof createHarness>> | null = null;

afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
});

function auditEvents(tenantId: string, event: string): Array<Record<string, unknown>> {
  return (
    harness!.db.db
      .prepare(
        "SELECT metadata_json FROM audit_logs WHERE tenant_id=? AND event=? ORDER BY created_at ASC"
      )
      .all(tenantId, event) as Array<{ metadata_json: string }>
  ).map((row) => JSON.parse(row.metadata_json) as Record<string, unknown>);
}

function settledUsage(tenantId: string): number | null {
  const row = harness!.db.db
    .prepare(
      "SELECT units FROM usage_events WHERE tenant_id=? AND state='settled' ORDER BY rowid DESC LIMIT 1"
    )
    .get(tenantId) as { units: number } | undefined;
  return row ? row.units : null;
}

/**
 * Issue #47: settlement must be explicit about overshoot, missing upstream
 * usage must be an observable warning condition, and upstream failures such as
 * 502 must write a sanitized llm.request audit event.
 */
describe('budget settlement overshoot and audit gaps (#47)', () => {
  it('records an explicit overshoot audit event when settlement exceeds the remaining budget', async () => {
    // Remaining budget for the day is 3000 (DAILY_BUDGET_UNITS=3000, nothing
    // used yet); the reservation fits (2200+4), but the reported usage of 4500
    // exceeds the effective limit, so settle must flag the overshoot.
    harness = createHarness(
      () =>
        new Response(
          JSON.stringify({ id: 'chatcmpl_mock', usage: { total_tokens: 4500 } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
      { DAILY_BUDGET_UNITS: 3000, UPSTREAM_CONTEXT_OVERHEAD_UNITS: 2200 }
    );
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${harness.token}` },
      payload: { model: 'lwrr-text', max_tokens: 4, messages: [{ role: 'user', content: 'ping' }] }
    });
    expect(res.statusCode).toBe(200);
    expect(settledUsage('tenant-a')).toBe(4500);
    const overshoots = auditEvents('tenant-a', 'budget.overshoot');
    expect(overshoots).toHaveLength(1);
    expect(overshoots[0]?.units).toBe(4500);
    expect(overshoots[0]?.limit).toBe(3000);
    // With no other usage that day, `remaining` before this settlement is the
    // full limit (the reservation's own row is excluded from `used`), so the
    // concrete overshoot is actual - limit = 1500 - not inflated by the
    // reservation's own estimate.
    expect(overshoots[0]?.remaining).toBe(3000);
    expect(overshoots[0]?.overshoot).toBe(1500);
  });

  it('emits an estimate-fallback warning when upstream reports no usage', async () => {
    harness = createHarness(
      () =>
        new Response(JSON.stringify({ id: 'chatcmpl_mock', choices: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }),
      { DAILY_BUDGET_UNITS: 10000, UPSTREAM_CONTEXT_OVERHEAD_UNITS: 2200 }
    );
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${harness.token}` },
      payload: { model: 'lwrr-text', max_tokens: 4, messages: [{ role: 'user', content: 'ping' }] }
    });
    expect(res.statusCode).toBe(200);
    // Settled with the estimate (which now includes overhead).
    expect(settledUsage('tenant-a')).toBeGreaterThanOrEqual(2200);
    const llm = auditEvents('tenant-a', 'llm.request');
    expect(llm).toHaveLength(1);
    expect(llm[0]?.reconciled).toBe(false);
    expect(llm[0]?.actual).toBeGreaterThanOrEqual(2200);
    // The fallback condition must be observable as its own bounded event.
    expect(auditEvents('tenant-a', 'budget.estimate_fallback')).toHaveLength(1);
  });

  it('writes a sanitized llm.request audit event for an upstream 502 and releases the reservation', async () => {
    harness = createHarness(
      () => new Response('upstream exploded', { status: 502 }),
      { DAILY_BUDGET_UNITS: 10000, UPSTREAM_CONTEXT_OVERHEAD_UNITS: 2200 }
    );
    const res = await harness.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${harness.token}` },
      payload: { model: 'lwrr-text', max_tokens: 4, messages: [{ role: 'user', content: 'ping' }] }
    });
    expect(res.statusCode).toBe(502);
    // The reservation was released, not settled: no reserved row remains.
    const states = (
      harness!.db.db
        .prepare("SELECT state FROM usage_events WHERE tenant_id='tenant-a' ORDER BY rowid ASC")
        .all() as Array<{ state: string }>
    ).map((row) => row.state);
    expect(states).toContain('released');
    expect(states).not.toContain('reserved');
    // The failure writes an audit event, sanitized: no prompt, no response body.
    const failures = auditEvents('tenant-a', 'llm.request');
    expect(failures.length).toBeGreaterThanOrEqual(1);
    const last = failures[failures.length - 1]!;
    expect(last?.status).toBe(502);
    expect(JSON.stringify(last)).not.toContain('ping');
    expect(JSON.stringify(last)).not.toContain('upstream exploded');
  });
});
