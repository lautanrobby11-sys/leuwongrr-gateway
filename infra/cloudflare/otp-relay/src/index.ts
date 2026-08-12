/**
 * OTP relay worker — Leuwongrr Gateway console login codes.
 *
 * The gateway cannot send email itself; it POSTs the one-time code here and
 * this worker delivers it via Resend. The gateway treats any non-2xx response
 * as a failed delivery (502 otp_delivery_failed), so every failure path below
 * returns an explicit error status.
 *
 * Secrets (wrangler secret put):
 *   OTP_WEBHOOK_TOKEN  — shared with the gateway's OTP_WEBHOOK_TOKEN
 *   RESEND_API_KEY     — Resend API key (Boss-owned)
 * Vars (wrangler.toml):
 *   OTP_FROM_EMAIL     — verified sender, e.g. no-reply@leuwongrr.cloud
 */

export interface Env {
  OTP_WEBHOOK_TOKEN: string;
  RESEND_API_KEY: string;
  OTP_FROM_EMAIL: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RE = /^[0-9]{6}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return json(405, { error: 'method_not_allowed' });
    }

    const auth = request.headers.get('authorization') ?? '';
    const expected = `Bearer ${env.OTP_WEBHOOK_TOKEN}`;
    if (auth !== expected) {
      return json(401, { error: 'unauthorized' });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: 'invalid_json' });
    }
    const payload = body as { email?: unknown; code?: unknown; ttl_minutes?: unknown };
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    const code = typeof payload.code === 'string' ? payload.code : '';
    const ttlMinutes =
      typeof payload.ttl_minutes === 'number' && Number.isFinite(payload.ttl_minutes)
        ? payload.ttl_minutes
        : 10;

    if (!EMAIL_RE.test(email)) return json(400, { error: 'invalid_email' });
    if (!CODE_RE.test(code)) return json(400, { error: 'invalid_code' });

    const resend = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        from: env.OTP_FROM_EMAIL,
        to: [email],
        subject: 'Leuwongrr login code',
        text: `Your Leuwongrr login code is ${code}. It expires in ${ttlMinutes} minutes. If you did not request this code, you can ignore this email.`,
        html: `<p>Your Leuwongrr login code is <strong>${code}</strong>.</p><p>It expires in ${ttlMinutes} minutes. If you did not request this code, you can ignore this email.</p>`
      })
    });

    if (!resend.ok) {
      const detail = await resend.text().catch(() => '');
      return json(502, { error: 'relay_upstream_failed', detail: detail.slice(0, 200) });
    }
    return json(200, { delivered: true });
  }
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}