import nodemailer from 'nodemailer';
import type { Config } from './config.js';

/**
 * ADR-014: SMTP OTP delivery for the console sign-in code.
 *
 * The module owns the only SMTP credential usage in the process: the password
 * reaches nodemailer directly and never enters a log, an error object, or the
 * HTTP response. Every failure is reduced to a fixed error code so the caller
 * cannot accidentally forward provider text (which can echo credentials) or
 * anything else sensitive.
 */

export type SmtpFailureCode =
  | 'smtp_auth_failed'
  | 'smtp_tls_failed'
  | 'smtp_timeout'
  | 'smtp_connection_failed'
  | 'smtp_provider_failed';

export class SmtpDeliverError extends Error {
  constructor(public readonly code: SmtpFailureCode) {
    super(`smtp delivery failed: ${code}`);
    this.name = 'SmtpDeliverError';
  }
}

export interface OtpMail {
  from: string;
  to: string;
  code: string;
  ttlMinutes: number;
}

export interface SentMail {
  from: string;
  to: string;
  subject: string;
  text: string;
}

/**
 * The structural surface nodemailer must satisfy. Keeping this minimal means
 * tests can verify classification and redaction with a fake transport, and a
 * future provider swap does not drag the rest of the process along.
 */
export interface SmtpTransport {
  sendMail(mail: SentMail): Promise<unknown>;
  close?(): void;
}

/**
 * Maps every nodemailer/network failure shape to one stable code. `err` is
 * intentionally `unknown` and structurally inspected: a provider that echoes
 * the password into its message is invisible here, because messages are never
 * carried across this boundary.
 */
export function classifySmtpFailure(err: unknown): SmtpFailureCode {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code)
      : '';
  const responseCode =
    typeof err === 'object' && err !== null && 'responseCode' in err
      ? (err as { responseCode: unknown }).responseCode
      : undefined;
  const hasResponse = typeof responseCode === 'number' && responseCode >= 400;
  if (code === 'EAUTH' || code === 'ELOGIN') return 'smtp_auth_failed';
  if (code === 'EPROTO' || code.startsWith('ERR_SSL') || code.startsWith('ERR_TLS')) {
    return 'smtp_tls_failed';
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKET') return 'smtp_timeout';
  if (
    code === 'ECONNECTION' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EHOSTUNREACH'
  ) {
    return 'smtp_connection_failed';
  }
  return hasResponse ? 'smtp_provider_failed' : 'smtp_provider_failed';
}

/**
 * Creates a transport from the validated configuration. Security is explicit:
 * `tls` means implicit TLS from the first byte, `starttls` means the STARTTLS
 * upgrade is mandatory (`requireTLS`), and no option means no plaintext mode
 * exists. Certificate validation always stays on. All phases are bounded by
 * their own timeout and there is no retry: a failing provider answers once.
 */
export function createSmtpTransport(config: Config): SmtpTransport {
  const host = config.SMTP_HOST;
  const port = config.SMTP_PORT;
  const security = config.SMTP_SECURITY;
  const username = config.SMTP_USERNAME;
  const password = config.SMTP_PASSWORD;
  const from = config.SMTP_FROM;
  if (!host || !port || !security || !username || !password || !from) {
    throw new Error('SMTP delivery is not fully configured');
  }
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: security === 'tls',
    requireTLS: security === 'starttls',
    auth: { user: username, pass: password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    tls: { rejectUnauthorized: true }
  });
  return {
    sendMail: (mail) => transport.sendMail(mail),
    close: () => transport.close()
  };
}

/**
 * Sends the sign-in code. The OTP itself is part of the message body by
 * design, so the returned value and the thrown error deliberately contain
 * nothing derivable from it: the error carries only the classification code.
 */
export async function sendOtpMail(transport: SmtpTransport, mail: OtpMail): Promise<{ delivered: true }> {
  try {
    await transport.sendMail({
      from: mail.from,
      to: mail.to,
      subject: 'LeuwongRR sign-in code',
      text: `Your LeuwongRR sign-in code is ${mail.code}. It expires in ${mail.ttlMinutes} minutes. If you did not request this code, ignore this email.`
    });
    return { delivered: true };
  } catch (err) {
    if (err instanceof SmtpDeliverError) throw err;
    throw new SmtpDeliverError(classifySmtpFailure(err));
  }
}
