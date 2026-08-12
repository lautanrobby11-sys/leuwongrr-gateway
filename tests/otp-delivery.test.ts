import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from './support/harness.js';
import { sendOtpMail, SmtpDeliverError } from '../src/otp-smtp.js';

vi.mock('../src/otp-smtp.js', () => {
  class MockSmtpDeliverError extends Error {
    constructor(public code: string) {
      super(code);
      this.name = 'SmtpDeliverError';
    }
  }
  return {
    SmtpDeliverError: MockSmtpDeliverError,
    createSmtpTransport: vi.fn(() => ({ sendMail: vi.fn() })),
    sendOtpMail: vi.fn(async () => ({ delivered: true }))
  };
});

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

const SMTP_ENV = {
  CONSOLE_ENABLED: true,
  OTP_DELIVERY: 'smtp',
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: 587,
  SMTP_SECURITY: 'starttls',
  SMTP_USERNAME: 'otp-sender',
  SMTP_PASSWORD: 's'.repeat(24),
  SMTP_FROM: 'no-reply@example.test'
} as const;

function startSmtp(): Harness {
  const active = createHarness(() => new Response('{}', { status: 200 }), SMTP_ENV);
  harness = active;
  return active;
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

  it('reports delivery when SMTP accepted the code, without exposing the code', async () => {
    const active = startSmtp();
    const response = await requestCode(active.app, 'reachable@example.com');
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ delivered: true });
    expect(body).not.toHaveProperty('dev_code');
    expect(response.body).not.toMatch(/[0-9]{6}/);
  });

  it('fails closed with otp_delivery_failed when SMTP delivery fails', async () => {
    const active = startSmtp();
    vi.mocked(sendOtpMail).mockRejectedValueOnce(new SmtpDeliverError('smtp_auth_failed'));
    const response = await requestCode(active.app, 'unreachable@example.com');
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('otp_delivery_failed');
    expect(response.body).not.toContain(SMTP_ENV.SMTP_PASSWORD);
  });
});
