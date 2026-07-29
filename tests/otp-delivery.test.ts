import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from './support/harness.js';

/**
 * A literal public address keeps the egress guard offline: it resolves nothing,
 * so the test exercises delivery handling rather than DNS.
 */
const RELAY = 'https://93.184.216.34/otp';
const CONSOLE_ORIGIN = 'http://127.0.0.1:2080';

let harness: Harness | null = null;

afterEach(async () => {
  vi.unstubAllGlobals();
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
});

function start(relayStatus: number): Harness {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: relayStatus }))
  );
  const active = createHarness(() => new Response('{}', { status: 200 }), {
    CONSOLE_ENABLED: true,
    OTP_DELIVERY: 'webhook',
    OTP_WEBHOOK_URL: RELAY
  });
  harness = active;
  return active;
}

function requestCode(app: Harness['app'], email: string) {
  return app.inject({
    method: 'POST',
    url: '/console/api/auth/request-code',
    headers: { origin: CONSOLE_ORIGIN },
    payload: { email }
  });
}

describe('one time code delivery', () => {
  it('reports delivery when the relay accepted the code', async () => {
    const active = start(202);
    const response = await requestCode(active.app, 'reachable@example.com');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ delivered: true });
  });

  it('fails closed when the relay rejects the code', async () => {
    const active = start(500);
    const response = await requestCode(active.app, 'unreachable@example.com');
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('otp_delivery_failed');
  });
});
