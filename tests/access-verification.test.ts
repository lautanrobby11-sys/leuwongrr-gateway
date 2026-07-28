import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AccessVerifier } from '../src/accounts/access.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'kid-primary';
const TEAM = 'leuwongrr.cloudflareaccess.com';
const ISSUER = `https://${TEAM}`;
const AUD = 'a'.repeat(32);

const jwk = {
  ...(publicKey.export({ format: 'jwk' }) as unknown as Record<string, unknown>),
  kid: KID,
  alg: 'RS256',
  use: 'sig'
};

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

interface TokenOptions {
  kid?: string | null;
  alg?: string;
  forge?: boolean;
}

function token(claims: Record<string, unknown>, options: TokenOptions = {}): string {
  const rawHeader: Record<string, unknown> = { alg: options.alg ?? 'RS256', typ: 'JWT' };
  if (options.kid !== null) rawHeader.kid = options.kid ?? KID;
  const header = encode(rawHeader);
  const payload = encode(claims);
  if (options.forge) {
    return `${header}.${payload}.${Buffer.from('forged-signature').toString('base64url')}`;
  }
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${signer.sign(privateKey).toString('base64url')}`;
}

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: 'owner@leuwongrr.cloud',
    sub: 'access-subject-1',
    aud: [AUD],
    iss: ISSUER,
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides
  };
}

function verifier(answers: readonly string[] = ['104.16.0.1']): AccessVerifier {
  const fetcher = (async () =>
    new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })) as unknown as typeof fetch;
  return new AccessVerifier(TEAM, AUD, 60_000, fetcher, async () => answers);
}

describe('Cloudflare Access assertion verification', () => {
  it('accepts an assertion signed by the published team key', async () => {
    const identity = await verifier().verify(token(validClaims()));
    expect(identity).toEqual({ email: 'owner@leuwongrr.cloud', subject: 'access-subject-1' });
  });

  it('refuses a forged signature', async () => {
    await expect(verifier().verify(token(validClaims(), { forge: true }))).rejects.toThrow(
      'access_signature_invalid'
    );
  });

  it('refuses an expired assertion', async () => {
    const expired = validClaims({ exp: Math.floor(Date.now() / 1000) - 5 });
    await expect(verifier().verify(token(expired))).rejects.toThrow('access_token_expired');
  });

  it('refuses an assertion minted for another application', async () => {
    const wrongAudience = validClaims({ aud: ['b'.repeat(32)] });
    await expect(verifier().verify(token(wrongAudience))).rejects.toThrow(
      'access_audience_mismatch'
    );
  });

  it('refuses an assertion from another team', async () => {
    const wrongIssuer = validClaims({ iss: 'https://someone-else.cloudflareaccess.com' });
    await expect(verifier().verify(token(wrongIssuer))).rejects.toThrow('access_issuer_mismatch');
  });

  it('refuses an algorithm the verifier does not check', async () => {
    await expect(
      verifier().verify(token(validClaims(), { alg: 'HS256' }))
    ).rejects.toThrow('access_alg_unsupported');
  });

  it('refuses a header that names no key', async () => {
    await expect(verifier().verify(token(validClaims(), { kid: null }))).rejects.toThrow(
      'access_kid_missing'
    );
  });

  it('refuses a key the team never published', async () => {
    await expect(verifier().verify(token(validClaims(), { kid: 'kid-unknown' }))).rejects.toThrow(
      'access_kid_unknown'
    );
  });

  it('refuses a token that is not three segments', async () => {
    await expect(verifier().verify('header.payload')).rejects.toThrow('access_token_malformed');
  });

  it('refuses an assertion carrying no identity', async () => {
    const anonymous = validClaims();
    delete anonymous.email;
    await expect(verifier().verify(token(anonymous))).rejects.toThrow('access_email_missing');
  });

  it('refuses to fetch certificates from a private address', async () => {
    await expect(verifier(['127.0.0.1']).verify(token(validClaims()))).rejects.toThrow(
      'egress_target_forbidden'
    );
  });
});
