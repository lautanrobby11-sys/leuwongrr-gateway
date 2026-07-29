import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';
import { assertPublicEgress } from '../policy/egress.js';

export type OauthProvider = 'google' | 'discord';

export interface OauthProfile {
  subject: string;
  email: string;
  displayName: string;
}

export class OauthError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number
  ) {
    super(code);
    this.name = 'OauthError';
  }
}

interface ProviderShape {
  authorizeUrl: string;
  tokenUrl: string;
  profileUrl: string;
  scope: string;
  clientId: string;
  clientSecret: string;
}

export function providerConfig(config: Config, provider: OauthProvider): ProviderShape {
  if (provider === 'google') {
    if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
      throw new OauthError('provider_not_configured', 404);
    }
    return {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      profileUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
      scope: 'openid email profile',
      clientId: config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET
    };
  }
  if (!config.DISCORD_CLIENT_ID || !config.DISCORD_CLIENT_SECRET) {
    throw new OauthError('provider_not_configured', 404);
  }
  return {
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    profileUrl: 'https://discord.com/api/users/@me',
    scope: 'identify email',
    clientId: config.DISCORD_CLIENT_ID,
    clientSecret: config.DISCORD_CLIENT_SECRET
  };
}

export function redirectUri(config: Config, provider: OauthProvider): string {
  return new URL(`/callbacks/${provider}`, config.PUBLIC_BASE_URL).toString();
}

/** PKCE is used for both providers so a stolen code alone is not enough. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function authorizeUrl(
  config: Config,
  provider: OauthProvider,
  state: string,
  challenge: string
): string {
  const shape = providerConfig(config, provider);
  const url = new URL(shape.authorizeUrl);
  url.searchParams.set('client_id', shape.clientId);
  url.searchParams.set('redirect_uri', redirectUri(config, provider));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', shape.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (provider === 'google') url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

export async function exchangeCode(
  config: Config,
  provider: OauthProvider,
  code: string,
  verifier: string,
  fetcher: typeof fetch = fetch
): Promise<OauthProfile> {
  const shape = providerConfig(config, provider);
  const tokenResponse = await fetcher(assertPublicEgress(shape.tokenUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: shape.clientId,
      client_secret: shape.clientSecret,
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri(config, provider)
    }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!tokenResponse.ok) throw new OauthError('oauth_exchange_failed', 502);
  const token = (await tokenResponse.json()) as { access_token?: string };
  if (!token.access_token) throw new OauthError('oauth_token_missing', 502);

  const profileResponse = await fetcher(assertPublicEgress(shape.profileUrl), {
    method: 'GET',
    headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(10_000)
  });
  if (!profileResponse.ok) throw new OauthError('oauth_profile_failed', 502);
  const profile = (await profileResponse.json()) as Record<string, unknown>;

  if (provider === 'google') {
    if (profile.email_verified === false) throw new OauthError('email_not_verified', 403);
    const email = typeof profile.email === 'string' ? profile.email : '';
    if (!email) throw new OauthError('email_missing', 403);
    return {
      subject: String(profile.sub ?? email),
      email,
      displayName: typeof profile.name === 'string' ? profile.name : email.split('@')[0] ?? 'member'
    };
  }

  if (profile.verified === false) throw new OauthError('email_not_verified', 403);
  const email = typeof profile.email === 'string' ? profile.email : '';
  if (!email) throw new OauthError('email_missing', 403);
  return {
    subject: String(profile.id ?? email),
    email,
    displayName:
      typeof profile.global_name === 'string'
        ? profile.global_name
        : typeof profile.username === 'string'
          ? profile.username
          : email.split('@')[0] ?? 'member'
  };
}

export interface TelegramLogin {
  id: string;
  hash: string;
  auth_date: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

/**
 * Telegram never sends an email address, so a Telegram login can only attach to
 * an account that already exists. The payload signature is checked against the
 * bot token and the timestamp is bounded in both directions to stop replay.
 */
export function verifyTelegramLogin(
  payload: Record<string, string>,
  botToken: string,
  maxAgeSeconds = 300,
  now: () => number = Date.now
): TelegramLogin {
  const { hash, ...rest } = payload;
  if (!hash) throw new OauthError('telegram_hash_missing', 400);
  const checkString = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join('\n');
  const secret = createHash('sha256').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(checkString).digest('hex');
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(hash, 'hex');
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new OauthError('telegram_signature_invalid', 403);
  }
  const authDate = Number(rest.auth_date ?? 0);
  const ageSeconds = now() / 1000 - authDate;
  // Thirty seconds accommodates ordinary edge/origin clock skew without
  // accepting a future assertion that remains replayable for an arbitrary time.
  if (
    !Number.isFinite(authDate) ||
    authDate <= 0 ||
    ageSeconds < -30 ||
    ageSeconds > maxAgeSeconds
  ) {
    throw new OauthError('telegram_payload_expired', 403);
  }
  if (!rest.id) throw new OauthError('telegram_id_missing', 400);
  return { ...(rest as unknown as TelegramLogin), hash };
}
