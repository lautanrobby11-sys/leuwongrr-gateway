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

interface StreamFixture {
  body: Response;
  cancelled: () => boolean;
  pulls: () => number;
}

/** Slow SSE body so the client can disconnect before the upstream finishes. */
function slowSseFixture(options: {
  chunks: string[];
  delayMs?: number;
  hangAfterFirst?: boolean;
}): StreamFixture {
  const encoder = new TextEncoder();
  let cancelled = false;
  let pulls = 0;
  let index = 0;
  const delayMs = options.delayMs ?? 40;

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      pulls += 1;
      if (cancelled) {
        controller.close();
        return;
      }
      if (index >= options.chunks.length) {
        if (options.hangAfterFirst) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 30_000);
            timer.unref?.();
          });
          if (!cancelled) controller.close();
          return;
        }
        controller.close();
        return;
      }
      const chunk = options.chunks[index];
      index += 1;
      controller.enqueue(encoder.encode(chunk));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        timer.unref?.();
      });
    },
    cancel() {
      cancelled = true;
    }
  });

  return {
    body: new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    }),
    cancelled: () => cancelled,
    pulls: () => pulls
  };
}

async function listen(active: Harness): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  await active.app.listen({ host: '127.0.0.1', port: 0 });
  const address = active.app.server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await active.app.close();
    }
  };
}

function settledUnits(active: Harness, tenantId = 'tenant-a'): number | null {
  const row = active.db.db
    .prepare("SELECT units FROM usage_events WHERE tenant_id=? AND state='settled' ORDER BY created_at DESC LIMIT 1")
    .get(tenantId) as { units: number } | undefined;
  return row ? row.units : null;
}

function usageStates(active: Harness, tenantId = 'tenant-a'): string[] {
  return (
    active.db.db
      .prepare('SELECT state FROM usage_events WHERE tenant_id=? ORDER BY created_at ASC')
      .all(tenantId) as Array<{ state: string }>
  ).map((row) => row.state);
}

function streamAuditCount(active: Harness, tenantId = 'tenant-a'): number {
  const row = active.db.db
    .prepare("SELECT COUNT(*) AS total FROM audit_logs WHERE tenant_id=? AND event='llm.stream.completed'")
    .get(tenantId) as { total: number };
  return row.total;
}

describe('SSE end-to-end streaming', () => {
  it('forwards a complete chat stream and settles reported usage', async () => {
    const fixture = slowSseFixture({
      chunks: [
        'data: {"id":"chatcmpl_stream","choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"usage":{"total_tokens":9}}\n\n',
        'data: [DONE]\n\n'
      ],
      delayMs: 10
    });
    harness = createHarness(() => fixture.body, { STREAM_IDLE_TIMEOUT_MS: 5_000 });
    const server = await listen(harness);

    try {
      const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${harness.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'lwrr-text',
          stream: true,
          messages: [{ role: 'user', content: 'hello' }]
        })
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const text = await response.text();
      expect(text).toContain('chatcmpl_stream');
      expect(text).toContain('[DONE]');
      expect(settledUnits(harness)).toBe(9);
      expect(streamAuditCount(harness)).toBe(1);
      expect(harness.upstreamCalls()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('cancels the upstream body when the client disconnects mid-stream', async () => {
    const fixture = slowSseFixture({
      chunks: [
        'data: {"id":"chatcmpl_abort","choices":[{"delta":{"content":"partial"}}]}\n\n',
        'data: {"usage":{"total_tokens":4}}\n\n',
        'data: [DONE]\n\n'
      ],
      delayMs: 80
    });
    harness = createHarness(() => fixture.body, { STREAM_IDLE_TIMEOUT_MS: 10_000 });
    const server = await listen(harness);

    try {
      const controller = new AbortController();
      const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${harness.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'lwrr-text',
          stream: true,
          messages: [{ role: 'user', content: 'abort me' }]
        }),
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
        // Abort can race with cancel; both mean the client is gone.
      }

      await expect
        .poll(() => fixture.cancelled() || usageStates(harness!).includes('released'), {
          timeout: 3_000,
          interval: 50
        })
        .toBe(true);

      // Disconnect path must not settle a successful stream charge.
      expect(settledUnits(harness)).toBeNull();
      expect(streamAuditCount(harness)).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('releases budget after stream idle timeout without settling usage', async () => {
    const fixture = slowSseFixture({
      chunks: ['data: {"id":"chatcmpl_idle","choices":[{"delta":{"content":"stalled"}}]}\n\n'],
      delayMs: 5,
      hangAfterFirst: true
    });
    harness = createHarness(() => fixture.body, { STREAM_IDLE_TIMEOUT_MS: 80 });
    const server = await listen(harness);

    try {
      const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${harness.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'lwrr-text',
          stream: true,
          messages: [{ role: 'user', content: 'stall' }]
        })
      });
      expect(response.status).toBe(200);
      // Drain until the gateway tears the stream down on idle timeout.
      await response.text();

      await expect
        .poll(() => usageStates(harness!).includes('released'), {
          timeout: 3_000,
          interval: 50
        })
        .toBe(true);
      expect(settledUnits(harness)).toBeNull();
      expect(streamAuditCount(harness)).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('returns 503 with retry-after when tenant stream concurrency is exhausted', async () => {
    // Hold the only tenant slot with a never-ending upstream stream.
    const blocker = slowSseFixture({
      chunks: ['data: {"id":"hold","choices":[{"delta":{"content":"x"}}]}\n\n'],
      delayMs: 5,
      hangAfterFirst: true
    });
    harness = createHarness(() => blocker.body, {
      TENANT_MAX_CONCURRENT: 1,
      STREAM_IDLE_TIMEOUT_MS: 10_000,
      UPSTREAM_CONCURRENCY: 4
    });
    const server = await listen(harness);

    try {
      const hold = await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${harness.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'lwrr-text',
          stream: true,
          messages: [{ role: 'user', content: 'hold slot' }]
        })
      });
      expect(hold.status).toBe(200);

      // Give the first stream time to acquire the tenant slot.
      await new Promise((resolve) => setTimeout(resolve, 60));

      const second = await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${harness.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'lwrr-text',
          stream: true,
          messages: [{ role: 'user', content: 'should 503' }]
        })
      });

      expect(second.status).toBe(503);
      expect(second.headers.get('retry-after')).toBeTruthy();
      const payload = (await second.json()) as { error?: { code?: string } };
      expect(payload.error?.code).toBe('tenant_overloaded');

      // Only the holder should have contacted upstream.
      expect(harness.upstreamCalls()).toBe(1);
      await hold.body?.cancel();
    } finally {
      await server.close();
    }
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
    const server = await listen(harness);

    try {
      const headers = {
        authorization: `Bearer ${harness.token}`,
        'content-type': 'application/json'
      };
      const payload = JSON.stringify({
        model: 'lwrr-text',
        messages: [{ role: 'user', content: 'load' }]
      });

      const first = await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: payload
      });
      const second = await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: payload
      });
      const third = await fetch(`${server.baseUrl}/v1/chat/completions`, {
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
    } finally {
      await server.close();
    }
  });
});
