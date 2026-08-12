import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { resolveRoute } from '../src/policy/allowlist.js';
import { requireModel, PolicyError } from '../src/policy/capabilities.js';
import { assertPublicEgress } from '../src/policy/egress.js';
import { BoundedSemaphore, OverloadError } from '../src/policy/semaphore.js';

const base = {
  NODE_ENV: 'test',
  API_KEY_PEPPER: 'x'.repeat(32),
  INTERNAL_READY_TOKEN: 'y'.repeat(32)
};

describe('configuration guardrails', () => {
  it('accepts canonical loopback values', () =>
    expect(loadConfig(base)).toMatchObject({
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: 2080,
      OMNIROUTE_URL: 'http://127.0.0.1:20128'
    }));
  it('rejects public bind', () =>
    expect(() => loadConfig({ ...base, GATEWAY_HOST: '0.0.0.0' })).toThrow());
  it('rejects non-loopback upstream', () =>
    expect(() => loadConfig({ ...base, OMNIROUTE_URL: 'https://router.example.com' })).toThrow());
  it('accepts a well-formed OmniRoute credential', () =>
    expect(loadConfig({ ...base, OMNIROUTE_API_KEY: 'k'.repeat(32) }).OMNIROUTE_API_KEY).toBe('k'.repeat(32)));
  it('rejects short or whitespace-padded OmniRoute credentials', () => {
    expect(() => loadConfig({ ...base, OMNIROUTE_API_KEY: 'short' })).toThrow();
    expect(() => loadConfig({ ...base, OMNIROUTE_API_KEY: ` ${'k'.repeat(32)}` })).toThrow(/whitespace/);
    expect(() => loadConfig({ ...base, OMNIROUTE_API_KEY: `${'k'.repeat(32)} ` })).toThrow(/whitespace/);
  });
  it('rejects development OTP disclosure in production', () =>
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        CONSOLE_ENABLED: 'true',
        OTP_DELIVERY: 'log'
      })
    ).toThrow(/production console requires OTP_DELIVERY=webhook/));
  it('requires both webhook URL and credential in production', () =>
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        CONSOLE_ENABLED: 'true',
        OTP_DELIVERY: 'webhook',
        OTP_WEBHOOK_URL: 'https://mail.example.com/send'
      })
    ).toThrow(/OTP_WEBHOOK_URL and OTP_WEBHOOK_TOKEN/));
  it('accepts a fully configured production OTP webhook', () =>
    expect(
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        CONSOLE_ENABLED: 'true',
        OTP_DELIVERY: 'webhook',
        OTP_WEBHOOK_URL: 'https://mail.example.com/send',
        OTP_WEBHOOK_TOKEN: 'z'.repeat(32),
        LEUWONGRR_WEBHOOK_SECRET: 's'.repeat(32)
      }).OTP_DELIVERY
    ).toBe('webhook'));
  const smtpEnv = {
    NODE_ENV: 'production',
    CONSOLE_ENABLED: 'true',
    OTP_DELIVERY: 'smtp',
    SMTP_HOST: 'smtp.example.test',
    SMTP_PORT: '465',
    SMTP_SECURITY: 'tls',
    SMTP_USERNAME: 'api-noreply@leuwongrr.online',
    SMTP_PASSWORD: 's'.repeat(24),
    SMTP_FROM: 'api-noreply@leuwongrr.online',
    LEUWONGRR_WEBHOOK_SECRET: 's'.repeat(32)
  };
  it('accepts a complete production OTP SMTP configuration', () =>
    expect(loadConfig({ ...base, ...smtpEnv }).OTP_DELIVERY).toBe('smtp'));
  it.each([
    ['SMTP_HOST', { SMTP_HOST: undefined }],
    ['SMTP_PORT', { SMTP_PORT: undefined }],
    ['SMTP_SECURITY', { SMTP_SECURITY: undefined }],
    ['SMTP_USERNAME', { SMTP_USERNAME: undefined }],
    ['SMTP_PASSWORD', { SMTP_PASSWORD: undefined }],
    ['SMTP_FROM', { SMTP_FROM: undefined }]
  ])('rejects smtp delivery missing %s', (_field, missing) =>
    expect(() => loadConfig({ ...base, ...smtpEnv, ...missing })).toThrow(/OTP_DELIVERY=smtp requires/));
  it('rejects a plaintext-only SMTP security value', () =>
    expect(() =>
      loadConfig({ ...base, ...smtpEnv, SMTP_SECURITY: 'none' })
    ).toThrow(/SMTP_SECURITY/));
  it('rejects an out-of-range SMTP port', () =>
    expect(() =>
      loadConfig({ ...base, ...smtpEnv, SMTP_PORT: '70000' })
    ).toThrow(/SMTP_PORT/));
  it('rejects a non-email SMTP_FROM', () =>
    expect(() =>
      loadConfig({ ...base, ...smtpEnv, SMTP_FROM: 'not-an-email' })
    ).toThrow(/SMTP_FROM/));
  it('accepts a starttls SMTP configuration without LEUWONGRR_WEBHOOK_SECRET when console is off', () =>
    expect(
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        CONSOLE_ENABLED: 'false',
        OTP_DELIVERY: 'smtp',
        SMTP_HOST: 'smtp.example.test',
        SMTP_PORT: '587',
        SMTP_SECURITY: 'starttls',
        SMTP_USERNAME: 'api-noreply@leuwongrr.online',
        SMTP_PASSWORD: 's'.repeat(24),
        SMTP_FROM: 'api-noreply@leuwongrr.online'
      }).OTP_DELIVERY
    ).toBe('smtp'));
  it('rejects an API key pepper that reuses an internal token (A20)', () => {
    expect(() =>
      loadConfig({
        ...base,
        API_KEY_PEPPER: 'p'.repeat(32),
        INTERNAL_READY_TOKEN: 'r'.repeat(32),
        INTERNAL_METRICS_TOKEN: 'p'.repeat(32)
      })
    ).toThrow(/API_KEY_PEPPER must differ from INTERNAL_METRICS_TOKEN/);
    expect(() =>
      loadConfig({
        ...base,
        API_KEY_PEPPER: 'y'.repeat(32),
        INTERNAL_METRICS_TOKEN: 'm'.repeat(32)
      })
    ).toThrow(/API_KEY_PEPPER must differ from INTERNAL_READY_TOKEN/);
  });
  it('accepts a pepper distinct from both internal tokens', () =>
    expect(
      loadConfig({
        ...base,
        INTERNAL_METRICS_TOKEN: 'm'.repeat(32),
        INTERNAL_READY_TOKEN: 'r'.repeat(32)
      }).API_KEY_PEPPER
    ).toBe('x'.repeat(32)));
});

describe('explicit route and capability policy', () => {
  it('allows only registered method/path pairs', () => {
    expect(resolveRoute('POST', '/v1/chat/completions')).toBe('chat.completions');
    expect(resolveRoute('GET', '/admin')).toBe('console.page');
    expect(resolveRoute('POST', '/admin')).toBeNull();
    expect(resolveRoute('GET', '/admin/anything')).toBeNull();
    expect(resolveRoute('POST', '/v1/unknown')).toBeNull();
  });
  it('rejects capability mismatch before upstream', () =>
    expect(() => requireModel('lwrr-text', ['tools'])).toThrow(PolicyError));
});

describe('egress policy', () => {
  it.each([
    'http://example.com',
    'https://127.0.0.1/x',
    'https://169.254.169.254/latest',
    'https://10.0.0.1',
    'https://metadata.google.internal'
  ])('rejects %s', (url) => expect(() => assertPublicEgress(url)).toThrow());
  it('accepts public HTTPS hostname', () =>
    expect(assertPublicEgress('https://hooks.example.com/event').hostname).toBe('hooks.example.com'));
});

describe('bounded concurrency', () => {
  it('fails fast rather than queueing', async () => {
    const gate = new BoundedSemaphore(1);
    let release!: () => void;
    const first = gate.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    await Promise.resolve();
    await expect(gate.run(async () => undefined)).rejects.toBeInstanceOf(OverloadError);
    release();
    await first;
  });
});
