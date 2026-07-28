import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Scopes backed by an implemented, allowlisted route. */
export type Scope =
  | 'models:read'
  | 'chat:write'
  | 'responses:write'
  | 'messages:write';

/** Reserved names are documented but cannot be issued before their routes exist. */
export type ReservedScope =
  | 'usage:read'
  | 'embeddings:write'
  | 'media:write'
  | 'files:write'
  | 'realtime:write';

export type KnownScope = Scope | ReservedScope;

/** Canonical implemented scope list used by operator tooling and validation. */
export const SCOPES: readonly Scope[] = [
  'models:read',
  'chat:write',
  'responses:write',
  'messages:write'
];

export type KeyMode = 'live' | 'test';

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  name: string;
  mode: KeyMode;
  keyHash: string;
  prefix: string;
  last4: string;
  scopes: ReadonlySet<Scope>;
  revokedAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export interface IssuedApiKey {
  plaintext: string;
  hash: string;
  prefix: string;
  last4: string;
  mode: KeyMode;
}

const KNOWN_SCOPES = new Set<Scope>(SCOPES);

export function issueApiKey(pepper: string, mode: KeyMode = 'live'): IssuedApiKey {
  const secret = randomBytes(32).toString('base64url');
  const plaintext = `lwrr_${mode}_${secret}`;
  return {
    plaintext,
    hash: hashApiKey(plaintext, pepper),
    prefix: `lwrr_${mode}_`,
    last4: plaintext.slice(-4),
    mode
  };
}

export function hashApiKey(value: string, pepper: string): string {
  return createHmac('sha256', pepper).update(value).digest('hex');
}

export function safeHashEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  return /^lwrr_(live|test)_[A-Za-z0-9_-]{40,}$/.test(token) ? token : null;
}

export function isScope(value: unknown): value is Scope {
  return typeof value === 'string' && KNOWN_SCOPES.has(value as Scope);
}

export function parseScopes(raw: unknown): Scope[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isScope);
}

export function parseKeyMode(value: unknown): KeyMode {
  return value === 'test' ? 'test' : 'live';
}

export function requireScope(record: ApiKeyRecord, scope: Scope): void {
  if (record.revokedAt || !record.scopes.has(scope)) throw new AuthError('insufficient_scope', 403);
}

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number
  ) {
    super(code);
  }
}
