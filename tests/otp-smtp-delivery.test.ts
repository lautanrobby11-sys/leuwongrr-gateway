import { describe, expect, it, vi } from 'vitest';
import {
  classifySmtpFailure,
  sendOtpMail,
  SmtpDeliverError,
  type SmtpTransport
} from '../src/otp-smtp.js';

/**
 * Redaction fixture: whatever the underlying transport error echoes — server
 * text, credentials, the code itself — the gateway-facing error must stay
 * clean, because that object can reach logs and responses.
 */
const PASSWORD = 'hunter2-smtp-password';
const CODE = '483920';

function transportThatThrows(error: unknown): SmtpTransport {
  return { sendMail: vi.fn(async () => Promise.reject(error)) };
}

function transportThatAccepts(): SmtpTransport {
  return { sendMail: vi.fn(async () => ({ accepted: ['otp@example.com'] })) };
}

describe('SMTP OTP delivery failure classification', () => {
  it.each([
    ['EAUTH', 'smtp_auth_failed'],
    ['ELOGIN', 'smtp_auth_failed'],
    ['ECONNECTION', 'smtp_connection_failed'],
    ['ECONNREFUSED', 'smtp_connection_failed'],
    ['ENOTFOUND', 'smtp_connection_failed'],
    ['EHOSTUNREACH', 'smtp_connection_failed'],
    ['ETIMEDOUT', 'smtp_timeout'],
    ['ESOCKET', 'smtp_timeout'],
    ['EPROTO', 'smtp_tls_failed'],
    ['ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE', 'smtp_tls_failed'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'smtp_tls_failed'],
    ['UNKNOWN_PROVIDER_CODE', 'smtp_provider_failed']
  ])('maps nodemailer code %s to %s', (code, expected) => {
    expect(classifySmtpFailure({ code })).toBe(expected);
  });

  it('maps a 5xx provider refusal to provider failure', () => {
    expect(classifySmtpFailure({ responseCode: 553, code: 'EENVELOPE' })).toBe(
      'smtp_provider_failed'
    );
  });

  it('maps a 4xx temporary provider refusal to provider failure', () => {
    expect(classifySmtpFailure({ responseCode: 451 })).toBe('smtp_provider_failed');
  });

  it('maps a non-object failure to provider failure', () => {
    expect(classifySmtpFailure('raw string')).toBe('smtp_provider_failed');
  });
});

describe('SMTP OTP send', () => {
  it('reports delivered when the provider accepted the message', async () => {
    const transport = transportThatAccepts();
    await expect(
      sendOtpMail(transport, {
        from: 'otp@example.com',
        to: 'member@example.com',
        code: CODE,
        ttlMinutes: 10
      })
    ).resolves.toEqual({ delivered: true });
    const mail = (transport.sendMail as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      from: string;
      to: string;
      text: string;
    };
    expect(mail.from).toBe('otp@example.com');
    expect(mail.to).toBe('member@example.com');
    expect(mail.text).toContain(CODE);
    expect(mail.text).toContain('10');
  });

  it('maps an auth refusal to a typed deliver error', async () => {
    const transport = transportThatThrows(
      Object.assign(new Error('Invalid login'), { code: 'EAUTH' })
    );
    await expect(
      sendOtpMail(transport, {
        from: 'otp@example.com',
        to: 'member@example.com',
        code: CODE,
        ttlMinutes: 10
      })
    ).rejects.toMatchObject({ code: 'smtp_auth_failed' });
  });

  it('maps a TLS failure to a typed deliver error', async () => {
    const transport = transportThatThrows(
      Object.assign(new Error('wrong version number'), { code: 'ERR_SSL_WRONG_VERSION_NUMBER' })
    );
    await expect(
      sendOtpMail(transport, {
        from: 'otp@example.com',
        to: 'member@example.com',
        code: CODE,
        ttlMinutes: 10
      })
    ).rejects.toMatchObject({ code: 'smtp_tls_failed' });
  });

  it('maps a timeout to a typed deliver error', async () => {
    const transport = transportThatThrows(
      Object.assign(new Error('greeting timeout'), { code: 'ETIMEDOUT' })
    );
    await expect(
      sendOtpMail(transport, {
        from: 'otp@example.com',
        to: 'member@example.com',
        code: CODE,
        ttlMinutes: 10
      })
    ).rejects.toMatchObject({ code: 'smtp_timeout' });
  });

  it('maps a connection refusal to a typed deliver error', async () => {
    const transport = transportThatThrows(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    );
    await expect(
      sendOtpMail(transport, {
        from: 'otp@example.com',
        to: 'member@example.com',
        code: CODE,
        ttlMinutes: 10
      })
    ).rejects.toMatchObject({ code: 'smtp_connection_failed' });
  });

  it('maps a provider 5xx refusal to a typed deliver error', async () => {
    const transport = transportThatThrows(
      Object.assign(new Error('mailbox unavailable'), {
        code: 'EENVELOPE',
        responseCode: 550
      })
    );
    await expect(
      sendOtpMail(transport, {
        from: 'otp@example.com',
        to: 'member@example.com',
        code: CODE,
        ttlMinutes: 10
      })
    ).rejects.toMatchObject({ code: 'smtp_provider_failed' });
  });

  it('never leaks the password or the code through the thrown error', async () => {
    const transport = transportThatThrows(
      Object.assign(new Error(`login denied for ${PASSWORD} code ${CODE}`), { code: 'EAUTH' })
    );
    const error = await sendOtpMail(transport, {
      from: 'otp@example.com',
      to: 'member@example.com',
      code: CODE,
      ttlMinutes: 10
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SmtpDeliverError);
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain(CODE);
  });
});
