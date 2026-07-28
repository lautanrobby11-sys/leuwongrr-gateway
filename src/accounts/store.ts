import type { Database } from 'better-sqlite3';
import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

export type AccountRole = 'member' | 'support' | 'operator' | 'admin' | 'owner';
export type IdentityProvider = 'email' | 'google' | 'discord' | 'telegram';

export interface AccountRecord {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  role: AccountRole;
  status: 'active' | 'suspended';
  createdAt: string;
  lastLoginAt: string | null;
}

interface AccountRow {
  id: string;
  tenant_id: string;
  email: string;
  display_name: string;
  role: AccountRole;
  status: 'active' | 'suspended';
  created_at: string;
  last_login_at: string | null;
}

export class AccountError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number
  ) {
    super(code);
    this.name = 'AccountError';
  }
}

function toRecord(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at
  };
}

/** Normalising here keeps one canonical spelling of an address in the table. */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Sessions and one-time codes are secrets. Only their HMAC lands in SQLite, so
 * a database copy cannot be replayed against the console.
 */
export class AccountStore {
  constructor(
    private readonly db: Database,
    private readonly pepper: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  private digest(value: string): string {
    return createHmac('sha256', this.pepper).update(value).digest('hex');
  }

  private iso(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }

  findByEmail(email: string): AccountRecord | null {
    const row = this.db
      .prepare('SELECT * FROM accounts WHERE email = ?')
      .get(normaliseEmail(email)) as AccountRow | undefined;
    return row ? toRecord(row) : null;
  }

  findById(id: string): AccountRecord | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
      | AccountRow
      | undefined;
    return row ? toRecord(row) : null;
  }

  findByTenant(tenantId: string): AccountRecord | null {
    const row = this.db
      .prepare('SELECT * FROM accounts WHERE tenant_id = ? ORDER BY created_at LIMIT 1')
      .get(tenantId) as AccountRow | undefined;
    return row ? toRecord(row) : null;
  }

  list(limit = 100): AccountRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM accounts ORDER BY created_at DESC LIMIT ?')
      .all(limit) as AccountRow[];
    return rows.map(toRecord);
  }

  /**
   * A member always owns exactly one tenant. Creating both in one transaction
   * prevents an account that can log in but has nothing to bill or meter.
   */
  create(input: {
    email: string;
    displayName?: string;
    role?: AccountRole;
    tenantId?: string;
  }): AccountRecord {
    const email = normaliseEmail(input.email);
    const tenantId = input.tenantId ?? `acct-${randomUUID().slice(0, 12)}`;
    const account: AccountRow = {
      id: randomUUID(),
      tenant_id: tenantId,
      email,
      display_name: input.displayName?.slice(0, 120) ?? email.split('@')[0] ?? 'member',
      role: input.role ?? 'member',
      status: 'active',
      created_at: this.iso(),
      last_login_at: null
    };
    const run = this.db.transaction(() => {
      this.db
        .prepare('INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?, ?, ?)')
        .run(tenantId, account.display_name, account.created_at);
      this.db
        .prepare(
          'INSERT INTO accounts (id, tenant_id, email, display_name, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          account.id,
          account.tenant_id,
          account.email,
          account.display_name,
          account.role,
          account.status,
          account.created_at
        );
      this.db
        .prepare('INSERT OR IGNORE INTO wallets (account_id, balance_tokens, updated_at) VALUES (?, 0, ?)')
        .run(account.id, account.created_at);
    });
    run();
    return toRecord(account);
  }

  setRole(accountId: string, role: AccountRole): void {
    this.db.prepare('UPDATE accounts SET role = ? WHERE id = ?').run(role, accountId);
  }

  setStatus(accountId: string, status: 'active' | 'suspended'): void {
    this.db.prepare('UPDATE accounts SET status = ? WHERE id = ?').run(status, accountId);
  }

  linkIdentity(accountId: string, provider: IdentityProvider, subject: string): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO account_identities (id, account_id, provider, subject, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(randomUUID(), accountId, provider, subject, this.iso());
  }

  findByIdentity(provider: IdentityProvider, subject: string): AccountRecord | null {
    const row = this.db
      .prepare(
        'SELECT a.* FROM accounts a JOIN account_identities i ON i.account_id = a.id WHERE i.provider = ? AND i.subject = ?'
      )
      .get(provider, subject) as AccountRow | undefined;
    return row ? toRecord(row) : null;
  }

  // ---- One-time codes ----

  /**
   * Returns the plaintext code exactly once so the caller can deliver it. The
   * resend window is enforced here rather than in the route, because that is
   * where the previous issue time actually lives.
   */
  issueLoginCode(email: string, ttlMinutes: number, resendSeconds: number): string {
    const address = normaliseEmail(email);
    const recent = this.db
      .prepare(
        'SELECT created_at FROM login_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1'
      )
      .get(address) as { created_at: string } | undefined;
    if (recent) {
      const elapsed = this.now().getTime() - Date.parse(recent.created_at);
      if (elapsed < resendSeconds * 1000) {
        throw new AccountError('code_requested_too_soon', 429);
      }
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.db
      .prepare(
        'INSERT INTO login_codes (id, email, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(randomUUID(), address, this.digest(code), this.iso(ttlMinutes * 60_000), this.iso());
    return code;
  }

  /**
   * Attempts are counted on the row itself, so a guesser cannot reset the
   * counter by opening a new connection.
   */
  consumeLoginCode(email: string, code: string, maxAttempts: number): boolean {
    const address = normaliseEmail(email);
    const row = this.db
      .prepare(
        'SELECT id, code_hash, attempts, expires_at FROM login_codes WHERE email = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1'
      )
      .get(address) as
      | { id: string; code_hash: string; attempts: number; expires_at: string }
      | undefined;
    if (!row) return false;
    if (Date.parse(row.expires_at) <= this.now().getTime()) return false;
    if (row.attempts >= maxAttempts) throw new AccountError('too_many_attempts', 429);

    this.db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    const expected = Buffer.from(row.code_hash, 'hex');
    const actual = Buffer.from(this.digest(code), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;

    this.db.prepare('UPDATE login_codes SET consumed_at = ? WHERE id = ?').run(this.iso(), row.id);
    return true;
  }

  // ---- Sessions ----

  createSession(accountId: string, ttlHours: number): string {
    const token = randomBytes(32).toString('base64url');
    this.db
      .prepare(
        'INSERT INTO sessions (id, account_id, token_hash, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(randomUUID(), accountId, this.digest(token), this.iso(), this.iso(ttlHours * 3_600_000));
    this.db.prepare('UPDATE accounts SET last_login_at = ? WHERE id = ?').run(this.iso(), accountId);
    return token;
  }

  resolveSession(token: string): AccountRecord | null {
    const row = this.db
      .prepare(
        'SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?'
      )
      .get(this.digest(token), this.iso()) as AccountRow | undefined;
    if (!row) return null;
    if (row.status !== 'active') return null;
    return toRecord(row);
  }

  revokeSession(token: string): void {
    this.db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(this.iso(), this.digest(token));
  }

  // ---- OAuth state ----

  saveOauthState(input: {
    state: string;
    provider: string;
    verifier: string;
    redirectPath: string;
    ttlMinutes: number;
  }): void {
    this.db
      .prepare(
        'INSERT INTO oauth_states (state, provider, verifier, redirect_path, expires_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        input.state,
        input.provider,
        input.verifier,
        input.redirectPath,
        this.iso(input.ttlMinutes * 60_000)
      );
  }

  /** Single use: the row is deleted whether or not it was still valid. */
  consumeOauthState(
    state: string,
    provider: string
  ): { verifier: string; redirectPath: string } | null {
    const row = this.db
      .prepare('SELECT verifier, redirect_path, expires_at, provider FROM oauth_states WHERE state = ?')
      .get(state) as
      | { verifier: string; redirect_path: string; expires_at: string; provider: string }
      | undefined;
    this.db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
    if (!row || row.provider !== provider) return null;
    if (Date.parse(row.expires_at) <= this.now().getTime()) return null;
    return { verifier: row.verifier, redirectPath: row.redirect_path };
  }

  /** Called from the existing maintenance tick; keeps auth tables bounded. */
  maintain(): void {
    const nowIso = this.iso();
    this.db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(nowIso);
    this.db.prepare('DELETE FROM login_codes WHERE expires_at <= ?').run(nowIso);
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso);
  }
}
