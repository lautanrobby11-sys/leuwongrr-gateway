import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type Scope = 'models:read'|'chat:write'|'usage:read';
export interface ApiKeyRecord { id:string; tenantId:string; keyHash:string; prefix:string; last4:string; scopes:ReadonlySet<Scope>; revokedAt:string|null }

export function issueApiKey(pepper: string, mode: 'live'|'test' = 'live') {
  const secret = randomBytes(32).toString('base64url');
  const plaintext = `lwrr_${mode}_${secret}`;
  return { plaintext, hash: hashApiKey(plaintext, pepper), prefix: `lwrr_${mode}_`, last4: plaintext.slice(-4) };
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

export function requireScope(record: ApiKeyRecord, scope: Scope): void {
  if (record.revokedAt || !record.scopes.has(scope)) throw new AuthError('insufficient_scope', 403);
}

export class AuthError extends Error {
  constructor(public readonly code: string, public readonly statusCode: number) { super(code); }
}
