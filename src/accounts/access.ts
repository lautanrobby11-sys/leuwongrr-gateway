import { createPublicKey, createVerify, type JsonWebKey } from 'node:crypto';
import { assertPublicEgress } from '../policy/egress.js';

export class AccessError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number
  ) {
    super(code);
    this.name = 'AccessError';
  }
}

interface AccessClaims {
  email?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iss?: string;
}

interface CertsResponse {
  keys?: Array<JsonWebKey & { kid?: string }>;
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/**
 * Cloudflare Access is the only thing standing in front of /admin, so the JWT
 * is verified properly: signature against the team JWKS, audience against the
 * configured application, and expiry. A decoded-but-unverified token would let
 * anyone who can reach the origin claim any email address.
 */
export class AccessVerifier {
  private keys = new Map<string, string>();
  private fetchedAt = 0;

  constructor(
    private readonly teamDomain: string,
    private readonly audience: string,
    private readonly cacheMs = 15 * 60 * 1000,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  private async refresh(): Promise<void> {
    if (this.keys.size > 0 && Date.now() - this.fetchedAt < this.cacheMs) return;
    const url = assertPublicEgress(`https://${this.teamDomain}/cdn-cgi/access/certs`);
    const response = await this.fetcher(url, {
      method: 'GET',
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new AccessError('access_certs_unavailable', 503);
    const body = (await response.json()) as CertsResponse;
    const next = new Map<string, string>();
    for (const jwk of body.keys ?? []) {
      if (!jwk.kid) continue;
      next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }).export({
        type: 'spki',
        format: 'pem'
      }) as string);
    }
    if (next.size === 0) throw new AccessError('access_certs_empty', 503);
    this.keys = next;
    this.fetchedAt = Date.now();
  }

  async verify(token: string): Promise<{ email: string; subject: string }> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new AccessError('access_token_malformed', 401);
    const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

    const header = decodeSegment(headerSegment) as { kid?: string; alg?: string };
    if (header.alg !== 'RS256') throw new AccessError('access_alg_unsupported', 401);
    if (!header.kid) throw new AccessError('access_kid_missing', 401);

    await this.refresh();
    const pem = this.keys.get(header.kid);
    if (!pem) throw new AccessError('access_kid_unknown', 401);

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerSegment}.${payloadSegment}`);
    verifier.end();
    if (!verifier.verify(pem, Buffer.from(signatureSegment, 'base64url'))) {
      throw new AccessError('access_signature_invalid', 401);
    }

    const claims = decodeSegment(payloadSegment) as AccessClaims;
    const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
    if (!audiences.includes(this.audience)) throw new AccessError('access_audience_mismatch', 403);
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) {
      throw new AccessError('access_token_expired', 401);
    }
    if (claims.iss !== `https://${this.teamDomain}`) {
      throw new AccessError('access_issuer_mismatch', 403);
    }
    if (!claims.email) throw new AccessError('access_email_missing', 403);
    return { email: claims.email, subject: claims.sub ?? claims.email };
  }
}
