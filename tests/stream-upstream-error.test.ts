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

async function listen(active: Harness): Promise<string> {
  await active.app.listen({ host: '127.0.0.1', port: 0 });
  const address = active.app.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

/**
 * A non-2xx upstream answer that carries a body, which is what OmniRoute
 * actually returns on failure. An empty-bodied error would not reproduce the
 * defect, because there would be nothing left unread.
 */
function upstreamErrorResponse(): Response {
  return new Response(JSON.stringify({ error: { message: 'upstream is busy' } }), {
    status: 502,
    headers: { 'content-type': 'application/json' }
  });
}

function sseResponse(): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"id":"chatcmpl_after_error","choices":[{"delta":{"content":"hi"}}]}\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

async function postChatStream(baseUrl: string, token: string, content: string): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'lwrr-text',
      stream: true,
      messages: [{ role: 'user', content }]
    })
  });
}

describe('upstream permit release on a failed streaming request', () => {
  it(
    'still serves a stream after the upstream rejected an earlier one',
    async () => {
      let calls = 0;
      harness = createHarness(
        () => {
          calls += 1;
          return calls === 1 ? upstreamErrorResponse() : sseResponse();
        },
        {
          // One permit makes a single leak fatal, so the assertion below fails
          // loudly instead of depending on the production default of four.
          UPSTREAM_CONCURRENCY: 1,
          STREAM_IDLE_TIMEOUT_MS: 5_000,
          REQUEST_TIMEOUT_MS: 5_000
        }
      );
      const baseUrl = await listen(harness);

      const failed = await postChatStream(baseUrl, harness.token, 'make the upstream fail');
      expect(failed.status).toBe(502);
      const failedPayload = (await failed.json()) as { error?: { code?: string } };
      expect(failedPayload.error?.code).toBe('upstream_error');

      const recovered = await postChatStream(baseUrl, harness.token, 'hello again');
      expect(recovered.status).toBe(200);
      expect(recovered.headers.get('content-type') ?? '').toContain('text/event-stream');
      expect(await recovered.text()).toContain('[DONE]');

      // Before the fix the second request never reached the upstream: the
      // semaphore was already exhausted, so this stayed at 1.
      expect(harness.upstreamCalls()).toBe(2);
    }
  );
});
