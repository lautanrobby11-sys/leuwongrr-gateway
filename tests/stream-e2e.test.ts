import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createHarness, type Harness } from './support/harness.js';

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
});

interface StreamControl {
  cancelled: () => boolean;
}

/**
 * Build a fresh SSE Response on every call. Reusing one Response body locks the
 * stream after the first upstream request and makes concurrent/retry cases flake.
 */
function createSseUpstream(options: {
  chunks: string[];
  delayMs?: number;
  hangAfterFirst?: boolean;
}): { respond: () => Response; control: StreamControl } {
  const encoder = new TextEncoder();
  let cancelled = false;
  const delayMs = options.delayMs ?? 20;

  const control: StreamControl = {
    cancelled: () => cancelled
  };

  const respond = (): Response => {
    let index = 0;
    cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (cancelled) {
          try {
            controller.close();
          } catch {
            // already closed by cancel()
          }
          return;
        }
        if (index >= options.chunks.length) {
          if (options.hangAfterFirst) {
            // Stay open until cancel/idle/timeout tears the stream down.
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 60_000);
              timer.unref?.();
            });
            if (!cancelled) {
              try {
                controller.close();
              } catch {
                // ignore
              }
            }
            return;
          }
          controller.close();
          return;
        }
        const chunk = options.chunks[index]!;
        index += 1;
        controller.enqueue(encoder.encode(chunk));
        if (index < options.chunks.length || options.hangAfterFirst) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delayMs);
            timer.unref?.();
          });
        }
      },
      cancel() {
        cancelled = true;
      }
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    });
  };

  return { respond, control };
}

async function listen(active: Harness): Promise<string> {
  await active.app.listen({ host: '127.0.0.1', port: 0 });
  const address = active.app.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function settledUnits(active: Harness, tenantId = 'tenant-a'): number | null {
  const row = active.db.db
    .prepare(
      "SELECT units FROM usage_events WHERE tenant_id=? AND state='settled' ORDER BY rowid DESC LIMIT 1"
    )
    .get(tenantId) as { units: number } | undefined;
  return row ? row.units : null;
}

function usageStates(active: Harness, tenantId = 'tenant-a'): string[] {
  return (
    active.db.db
      .prepare('SELECT state FROM usage_events WHERE tenant_id=? ORDER BY rowid ASC')
      .all(tenantId) as Array<{ state: string }>
  ).map((row) => row.state);
}

function streamAuditCount(active: Harness, tenantId = 'tenant-a'): number {
  const row = active.db.db
    .prepare("SELECT COUNT(*) AS total FROM audit_logs WHERE tenant_id=? AND event='llm.stream.completed'")
    .get(tenantId) as { total: number };
  return row.total;
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5_000
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function postChat(
  baseUrl: string,
  token: string,
  content: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  headers.set('content-type', 'application/json');
  return fetch(`${baseUrl}/v1/chat/completions`, {
    ...init,
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'lwrr-text',
      stream: true,
      messages: [{ role: 'user', content }]
    })
  });
}

describe('SSE end-to-end streaming', () => {
  it('forwards a complete chat stream and settles reported usage', async () => {
    const { respond } = createSseUpstream({
      chunks: [
        'data: {"id":"chatcmpl_stream","choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"usage":{"total_tokens":9}}\n\n',
        'data: [DONE]\n\n'
      ],
      delayMs: 5
    });
    harness = createHarness(respond, {
      STREAM_IDLE_TIMEOUT_MS: 5_000,
      REQUEST_TIMEOUT_MS: 5_000
    });
    const baseUrl = await listen(harness);

    const response = await postChat(baseUrl, harness.token, 'hello');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type') ?? '').toContain('text/event-stream');
    const text = await response.text();
    expect(text).toContain('chatcmpl_stream');
    expect(text).toContain('[DONE]');

    await waitFor(() => settledUnits(harness!) === 9, 'settled usage units');
    await waitFor(() => streamAuditCount(harness!) === 1, 'stream completed audit');
    expect(harness.upstreamCalls()).toBe(1);
  });

  it('cancels the upstream body when the client disconnects mid-stream', async () => {
    const { respond, control } = createSseUpstream({
      // First byte then hang so abort cannot race a full completion.
      chunks: ['data: {"id":"chatcmpl_abort","choices":[{"delta":{"content":"partial"}}]}\n\n'],
      delayMs: 5,
      hangAfterFirst: true
    });
    harness = createHarness(respond, {
      STREAM_IDLE_TIMEOUT_MS: 30_000,
      REQUEST_TIMEOUT_MS: 30_000
    });
    const baseUrl = await listen(harness);

    const controller = new AbortController();
    const response = await postChat(baseUrl, harness.token, 'abort me', {
      signal: controller.signal
    });
    expect(response.status).toBe(200);
    expect(response.body).not.toBeNull();

    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    controller.abort();
    try {
      await reader.cancel();
    } catch {
      // AbortError is expected once the client is gone.
    }

    await waitFor(
      () => control.cancelled() || usageStates(harness!).includes('released'),
      'upstream cancel or budget release'
    );
    // Disconnect must never settle a successful stream charge.
    expect(settledUnits(harness)).toBeNull();
    expect(streamAuditCount(harness)).toBe(0);
  });

  it('releases budget after stream idle timeout without settling usage', async () => {
    const { respond } = createSseUpstream({
      chunks: ['data: {"id":"chatcmpl_idle","choices":[{"delta":{"content":"stalled"}}]}\n\n'],
      delayMs: 5,
      hangAfterFirst: true
    });
    harness = createHarness(respond, {
      STREAM_IDLE_TIMEOUT_MS: 120,
      REQUEST_TIMEOUT_MS: 10_000
    });
    const baseUrl = await listen(harness);

    const response = await postChat(baseUrl, harness.token, 'stall');
    expect(response.status).toBe(200);
    // Drain until idle timeout destroys the upstream stream.
    await response.text();

    await waitFor(() => usageStates(harness!).includes('released'), 'idle timeout budget release');
    expect(settledUnits(harness)).toBeNull();
    expect(streamAuditCount(harness)).toBe(0);
  });

  it('returns 503 with retry-after when tenant stream concurrency is exhausted', async () => {
    const { respond } = createSseUpstream({
      chunks: ['data: {"id":"hold","choices":[{"delta":{"content":"x"}}]}\n\n'],
      delayMs: 5,
      hangAfterFirst: true
    });
    harness = createHarness(respond, {
      TENANT_MAX_CONCURRENT: 1,
      STREAM_IDLE_TIMEOUT_MS: 30_000,
      REQUEST_TIMEOUT_MS: 30_000,
      UPSTREAM_CONCURRENCY: 4
    });
    const baseUrl = await listen(harness);

    const hold = await postChat(baseUrl, harness.token, 'hold slot');
    expect(hold.status).toBe(200);
    expect(hold.body).not.toBeNull();
    const holdReader = hold.body!.getReader();
    // Wait until the first stream has acquired the tenant slot and started piping.
    const firstByte = await holdReader.read();
    expect(firstByte.done).toBe(false);

    const second = await postChat(baseUrl, harness.token, 'should 503');
    expect(second.status).toBe(503);
    expect(second.headers.get('retry-after')).toBeTruthy();
    const payload = (await second.json()) as { error?: { code?: string } };
    expect(payload.error?.code).toBe('tenant_overloaded');
    expect(harness.upstreamCalls()).toBe(1);

    await holdReader.cancel().catch(() => undefined);
  });
});

describe('mock load rejection envelope', () => {
  it('returns 429 with retry-after under credential burst pressure', async () => {
    harness = createHarness(
      () =>
        new Response(JSON.stringify({ id: 'chatcmpl_mock', choices: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }),
      { RATE_LIMIT_RPM: 60, RATE_LIMIT_BURST: 2 }
    );
    const baseUrl = await listen(harness);

    const headers = {
      authorization: `Bearer ${harness.token}`,
      'content-type': 'application/json'
    };
    const payload = JSON.stringify({
      model: 'lwrr-text',
      messages: [{ role: 'user', content: 'load' }]
    });

    const first = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: payload
    });
    const second = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: payload
    });
    const third = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: payload
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBeTruthy();
    const body = (await third.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('rate_limited');
  });
});
