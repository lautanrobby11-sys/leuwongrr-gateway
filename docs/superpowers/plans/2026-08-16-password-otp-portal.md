# Password + OTP Authentication and Portal Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add disciplined password + OTP authentication (register, login, reset, legacy set-password) and refresh the public portal and login page, without weakening any existing security invariant.

**Architecture:** A new forward-only migration adds `password_hash` and `email_verified_at` to `accounts` and a `purpose` column to `login_codes`. A dedicated `src/accounts/passwords.ts` module owns scrypt hashing. `AccountStore` gains purpose-aware OTP issue/consume plus password persistence. New routes are added to `src/http/console.ts` and kept in lockstep with `src/policy/allowlist.ts`, `DOCUMENTED_OPERATIONS`, and `docs/api/openapi.yaml` (enforced by `tests/openapi-contract.test.ts`). The frontend gets a reusable `PasswordInput` with an accessible eye toggle, a focused `/login` auth shell, a portal SEO refresh, and a member set-password banner.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, zod, Node `crypto.scrypt`, React 19, Vite, Tailwind, Vitest (Node + happy-dom projects).

## Global Constraints

- Every new route MUST be added to `src/policy/allowlist.ts`, `DOCUMENTED_OPERATIONS`, and `docs/api/openapi.yaml` in the same commit, or `tests/openapi-contract.test.ts` fails.
- Migrations are forward-only and appended to `MIGRATIONS` in `src/persistence/migrations.ts`. Never edit an existing migration.
- Passwords, password hashes, OTPs, and provider secrets MUST NOT appear in logs, audit `metadata_json`, response bodies, or the repository. Audit metadata records only non-secret identifiers (e.g. `method: 'password'`).
- Password storage uses scrypt via `node:crypto` only. No new runtime dependency is added.
- API-key HMAC storage, Cloudflare Access admin authority, OmniRoute access, and billing settlement are NOT modified.
- No filename may carry `-new`, `-final`, `-fix`, `-backup`, `-old`, `-temp`, etc. (`scripts/check-conventions.mjs` enforces this).
- Generic authentication errors must not reveal whether an email exists (anti-enumeration).
- Run `npm run validate` after each task. Run `npm run ci:local` before the final docs/release task.
- The console is a separate Vite build (`web/`); DOM tests live in `web/src/**/*.dom.test.tsx` and run under the `console-dom` Vitest project.

---

## Task 1: Password hashing module

**Files:**
- Create: `src/accounts/passwords.ts`
- Test: `tests/password-hashing.test.ts`

**Interfaces:**
- Produces: `hashPassword(plain: string): string`, `verifyPassword(plain: string, stored: string): boolean`, `PASSWORD_MIN_LENGTH`, `PASSWORD_MAX_LENGTH`, `validatePasswordStrength(password: string): string | null`

- [x] **Step 1: Write the failing test**

Create `tests/password-hashing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  PASSWORD_MIN_LENGTH
} from '../src/accounts/passwords.js';

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', () => {
    const hash = hashPassword('correct-horse-battery-staple');
    expect(verifyPassword('correct-horse-battery-staple', hash)).toBe(true);
    expect(verifyPassword('wrong-password-value-here!!', hash)).toBe(false);
  });

  it('produces a unique salt per hash', () => {
    const a = hashPassword('same-password-value-12345');
    const b = hashPassword('same-password-value-12345');
    expect(a).not.toBe(b);
    expect(verifyPassword('same-password-value-12345', a)).toBe(true);
    expect(verifyPassword('same-password-value-12345', b)).toBe(true);
  });

  it('rejects a malformed stored hash instead of throwing', () => {
    expect(verifyPassword('anything', 'not-a-real-hash')).toBe(false);
    expect(verifyPassword('anything', '')).toBe(false);
  });
});

describe('password strength', () => {
  it('accepts a long password and rejects a short one', () => {
    expect(validatePasswordStrength('a'.repeat(PASSWORD_MIN_LENGTH))).toBeNull();
    expect(validatePasswordStrength('short')).toMatch(/at least/i);
  });

  it('rejects an overlong password', () => {
    expect(validatePasswordStrength('a'.repeat(200))).toMatch(/too long/i);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/password-hashing.test.ts`
Expected: FAIL — cannot resolve `../src/accounts/passwords.js`.

- [x] **Step 3: Write the implementation**

Create `src/accounts/passwords.ts`:

```ts
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Console passwords are permanent credentials, so they use a slow memory-hard
 * KDF rather than the fast HMAC used for short-lived API keys and OTP codes.
 * The stored format is self-describing so the cost parameters can be raised
 * later without a migration: scrypt$N$r$p$saltHex$hashHex.
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const derived = scryptSync(plain, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  const derived = scryptSync(plain, salt, expected.length, { N, r, p });
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** Returns a human-readable reason, or null when the password is acceptable. */
export function validatePasswordStrength(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return 'Password is too long.';
  }
  return null;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/password-hashing.test.ts`
Expected: PASS (5 tests).

- [x] **Step 5: Commit**

```bash
git add src/accounts/passwords.ts tests/password-hashing.test.ts
git commit -m "feat(auth): add scrypt password hashing module"
```

---

## Task 2: Migration 0016 + purpose-aware OTP + password persistence in the store

**Files:**
- Modify: `src/persistence/migrations.ts` (append migration after `0015_usage_event_details`)
- Modify: `src/accounts/store.ts`
- Test: `tests/migration-0016.test.ts`
- Test: extend `tests/auth-and-database.test.ts` (or add `tests/account-password-store.test.ts`)

**Interfaces:**
- Consumes: `hashPassword` from Task 1 (used by callers, not the store itself).
- Produces: `AccountStore.issueCode(email, purpose, ttlMinutes, resendSeconds)`, `AccountStore.consumeCode(email, code, purpose, maxAttempts)`, `AccountStore.setPassword(accountId, hash)`, `AccountStore.hasPassword(accountId)`, `AccountStore.markEmailVerified(accountId)`, `AccountRecord.passwordHash: string | null`, `AccountRecord.emailVerifiedAt: string | null`. Existing `issueLoginCode`/`consumeLoginCode` remain as thin wrappers so current call sites keep working.

- [x] **Step 1: Write the failing migration test**

Create `tests/migration-0016.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createTempDatabase } from './support/harness.js';

describe('migration 0016_account_passwords', () => {
  it('adds password and verification columns and backfills existing accounts as verified', () => {
    const { db, dispose } = createTempDatabase();
    try {
      // The harness seeds one account; it must be treated as already verified.
      const row = db.db
        .prepare('SELECT password_hash, email_verified_at FROM accounts LIMIT 1')
        .get() as { password_hash: string | null; email_verified_at: string | null };
      expect(row.password_hash).toBeNull();
      expect(row.email_verified_at).not.toBeNull();

      // login_codes carries a purpose column defaulting to login.
      const info = db.db.prepare("PRAGMA table_info(login_codes)").all() as Array<{ name: string }>;
      expect(info.some((col) => col.name === 'purpose')).toBe(true);

      expect(db.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      dispose();
    }
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/migration-0016.test.ts`
Expected: FAIL — `password_hash` column does not exist.

- [x] **Step 3: Add the migration**

In `src/persistence/migrations.ts`, append after the `0015_usage_event_details` entry (before the closing `}]`):

```ts
, {
  // Console accounts gain a permanent password credential and an explicit
  // email-verification marker (console overhaul auth foundation). password_hash
  // is nullable because legacy and OAuth accounts start without one. Every
  // pre-existing account is backfilled as verified: each already proved its
  // address through OTP or a federated provider, so a NULL email_verified_at
  // afterwards unambiguously means "registration started, OTP not yet passed".
  // login_codes gains a purpose so register/login/reset challenges cannot be
  // consumed by the wrong flow.
  id: '0016_account_passwords',
  sql: `
ALTER TABLE accounts ADD COLUMN password_hash TEXT;
ALTER TABLE accounts ADD COLUMN email_verified_at TEXT;
UPDATE accounts SET email_verified_at = created_at WHERE email_verified_at IS NULL;
ALTER TABLE login_codes ADD COLUMN purpose TEXT NOT NULL DEFAULT 'login' CHECK(purpose IN ('login','register','reset'));
`
}]
```

- [x] **Step 4: Run migration test to verify it passes**

Run: `npx vitest run tests/migration-0016.test.ts`
Expected: PASS.

- [x] **Step 5: Write the failing store test**

Create `tests/account-password-store.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts/store.js';
import { hashPassword, verifyPassword } from '../src/accounts/passwords.js';
import { createTempDatabase, testConfig } from './support/harness.js';

describe('AccountStore password and purpose-aware OTP', () => {
  it('stores and reports a password hash without exposing it on the record', () => {
    const { db, dispose } = createTempDatabase();
    try {
      const store = new AccountStore(db.db, testConfig.API_KEY_PEPPER);
      const account = store.create({ email: 'pw@example.test', displayName: 'Pw' });
      expect(store.hasPassword(account.id)).toBe(false);
      store.setPassword(account.id, hashPassword('a-strong-password-1'));
      expect(store.hasPassword(account.id)).toBe(true);
      const record = store.findById(account.id);
      expect(record?.passwordHash).toBeNull(); // never surfaced as plaintext
      const raw = db.db.prepare('SELECT password_hash FROM accounts WHERE id=?').get(account.id) as { password_hash: string };
      expect(verifyPassword('a-strong-password-1', raw.password_hash)).toBe(true);
    } finally {
      dispose();
    }
  });

  it('marks an account email-verified', () => {
    const { db, dispose } = createTempDatabase();
    try {
      const store = new AccountStore(db.db, testConfig.API_KEY_PEPPER);
      const account = store.create({ email: 'verify@example.test' });
      store.markEmailVerified(account.id);
      expect(store.findById(account.id)?.emailVerifiedAt).not.toBeNull();
    } finally {
      dispose();
    }
  });

  it('keeps register, login, and reset codes separate', () => {
    const { db, dispose } = createTempDatabase();
    try {
      const store = new AccountStore(db.db, testConfig.API_KEY_PEPPER);
      const registerCode = store.issueCode('multi@example.test', 'register', 10, 0);
      // A login consume must not accept a register code.
      expect(store.consumeCode('multi@example.test', registerCode, 'login', 5)).toBe(false);
      expect(store.consumeCode('multi@example.test', registerCode, 'register', 5)).toBe(true);
    } finally {
      dispose();
    }
  });
});
```

- [x] **Step 6: Run store test to verify it fails**

Run: `npx vitest run tests/account-password-store.test.ts`
Expected: FAIL — `issueCode`/`setPassword` not defined.

- [x] **Step 7: Extend `AccountStore`**

In `src/accounts/store.ts`:

Add `passwordHash` and `emailVerifiedAt` to `AccountRecord` and `AccountRow`, and map them in `toRecord` (always return `passwordHash: null` on the record so the hash is never carried into API responses; the store reads it directly when verifying):

```ts
export interface AccountRecord {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  role: AccountRole;
  status: 'active' | 'suspended';
  createdAt: string;
  lastLoginAt: string | null;
  emailVerifiedAt: string | null;
  /** Always null on records; the hash is only ever read inside the store. */
  passwordHash: null;
}
```

Update `AccountRow` with `password_hash: string | null; email_verified_at: string | null;` and `toRecord`:

```ts
function toRecord(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    emailVerifiedAt: row.email_verified_at,
    passwordHash: null
  };
}
```

Add purpose-aware OTP methods and password helpers to the class (place near the existing one-time-code section). Keep `issueLoginCode`/`consumeLoginCode` as wrappers:

```ts
  /**
   * Purpose-aware one-time code issue. The purpose is stored alongside the hash
   * so a register code can never be consumed by the login flow (or vice versa).
   */
  issueCode(email: string, purpose: 'login' | 'register' | 'reset', ttlMinutes: number, resendSeconds: number): string {
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
        'INSERT INTO login_codes (id, email, code_hash, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(randomUUID(), address, this.digest(code), purpose, this.iso(ttlMinutes * 60_000), this.iso());
    return code;
  }

  consumeCode(email: string, code: string, purpose: 'login' | 'register' | 'reset', maxAttempts: number): boolean {
    const address = normaliseEmail(email);
    const row = this.db
      .prepare(
        'SELECT id, code_hash, attempts, expires_at FROM login_codes WHERE email = ? AND purpose = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1'
      )
      .get(address, purpose) as
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

  issueLoginCode(email: string, ttlMinutes: number, resendSeconds: number): string {
    return this.issueCode(email, 'login', ttlMinutes, resendSeconds);
  }

  consumeLoginCode(email: string, code: string, maxAttempts: number): boolean {
    return this.consumeCode(email, code, 'login', maxAttempts);
  }

  // ---- Passwords ----

  setPassword(accountId: string, passwordHash: string): void {
    this.db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(passwordHash, accountId);
  }

  hasPassword(accountId: string): boolean {
    const row = this.db
      .prepare('SELECT password_hash FROM accounts WHERE id = ?')
      .get(accountId) as { password_hash: string | null } | undefined;
    return Boolean(row?.password_hash);
  }

  /** Returns the stored hash for verification only; never call from a route. */
  getPasswordHash(accountId: string): string | null {
    const row = this.db
      .prepare('SELECT password_hash FROM accounts WHERE id = ?')
      .get(accountId) as { password_hash: string | null } | undefined;
    return row?.password_hash ?? null;
  }

  markEmailVerified(accountId: string): void {
    this.db
      .prepare('UPDATE accounts SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL')
      .run(this.iso(), accountId);
  }
```

- [x] **Step 8: Run store test to verify it passes**

Run: `npx vitest run tests/account-password-store.test.ts tests/migration-0016.test.ts`
Expected: PASS.

- [x] **Step 9: Run the full backend suite to catch regressions**

Run: `npx vitest run tests/auth-and-database.test.ts tests/console-surface.test.ts`
Expected: PASS (existing OTP behaviour unchanged via the wrappers).

- [x] **Step 10: Commit**

```bash
git add src/persistence/migrations.ts src/accounts/store.ts tests/migration-0016.test.ts tests/account-password-store.test.ts
git commit -m "feat(auth): migration 0016 and purpose-aware OTP + password store"
```

---

## Task 3: Registration routes (register + register/verify)

**Files:**
- Modify: `src/http/console.ts`
- Modify: `src/policy/allowlist.ts`
- Modify: `docs/api/openapi.yaml`
- Test: `tests/console-auth-register.test.ts`

**Interfaces:**
- Consumes: `hashPassword`, `validatePasswordStrength` (Task 1); `AccountStore.issueCode/consumeCode/setPassword/markEmailVerified/findByEmail` (Task 2); `setSessionCookie`, `fail`, `handle` (existing in console.ts).
- Produces: `POST /console/api/auth/register` → `{ delivered: boolean; ttl_minutes: number; dev_code?: string }`; `POST /console/api/auth/register/verify` → `{ authenticated: true; role: string }` + session cookie.

- [x] **Step 1: Write the failing route test**

Create `tests/console-auth-register.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, jsonResponse, testConfig, type Harness } from './support/harness.js';

const CONSOLE_ORIGIN = 'http://127.0.0.1:2080';
let harness: Harness | null = null;
let distRoot: string | null = null;

afterEach(async () => {
  if (harness) { await harness.cleanup(); harness = null; }
  if (distRoot) { rmSync(distRoot, { recursive: true, force: true }); distRoot = null; }
});

function buildDist(): string {
  const root = mkdtempSync(join(tmpdir(), 'lwrr-dist-'));
  distRoot = root;
  mkdirSync(join(root, 'assets'), { recursive: true });
  for (const page of ['index', 'login', 'member']) {
    writeFileSync(join(root, `${page}.html`), `<!doctype html><title>${page}</title>`, 'utf8');
  }
  return root;
}

function start(overrides: Record<string, unknown> = {}): Harness {
  harness = createHarness(jsonResponse, { CONSOLE_ENABLED: true, WEB_DIST_PATH: buildDist(), ...overrides });
  return harness;
}

const STRONG = 'a-very-strong-passphrase-1';

describe('console registration', () => {
  it('registers a pending account and activates it only after OTP verification', async () => {
    const active = start();
    const issued = await active.app.inject({
      method: 'POST',
      url: '/console/api/auth/register',
      headers: { origin: CONSOLE_ORIGIN },
      payload: { name: 'New Member', email: 'new@example.test', password: STRONG, confirmPassword: STRONG }
    });
    expect(issued.statusCode).toBe(200);
    const devCode = issued.json().dev_code as string;
    expect(devCode).toMatch(/^[0-9]{6}$/);

    // No session yet: the account is pending verification.
    const account = active.db.db.prepare("SELECT email_verified_at FROM accounts WHERE email='new@example.test'").get() as { email_verified_at: string | null };
    expect(account.email_verified_at).toBeNull();

    const verified = await active.app.inject({
      method: 'POST',
      url: '/console/api/auth/register/verify',
      headers: { origin: CONSOLE_ORIGIN },
      payload: { email: 'new@example.test', code: devCode }
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().authenticated).toBe(true);
    expect(verified.headers['set-cookie']).toContain(testConfig.SESSION_COOKIE_NAME);

    const after = active.db.db.prepare("SELECT email_verified_at, password_hash FROM accounts WHERE email='new@example.test'").get() as { email_verified_at: string | null; password_hash: string | null };
    expect(after.email_verified_at).not.toBeNull();
    expect(after.password_hash).not.toBeNull();
  });

  it('rejects mismatched confirmation and weak passwords', async () => {
    const active = start();
    const mismatch = await active.app.inject({
      method: 'POST', url: '/console/api/auth/register', headers: { origin: CONSOLE_ORIGIN },
      payload: { name: 'A', email: 'x@example.test', password: STRONG, confirmPassword: 'different-value-here-1' }
    });
    expect(mismatch.statusCode).toBe(400);

    const weak = await active.app.inject({
      method: 'POST', url: '/console/api/auth/register', headers: { origin: CONSOLE_ORIGIN },
      payload: { name: 'A', email: 'y@example.test', password: 'short', confirmPassword: 'short' }
    });
    expect(weak.statusCode).toBe(400);
  });

  it('does not reveal that an email is already registered', async () => {
    const active = start();
    const body = { name: 'Dup', email: 'dup@example.test', password: STRONG, confirmPassword: STRONG };
    const first = await active.app.inject({ method: 'POST', url: '/console/api/auth/register', headers: { origin: CONSOLE_ORIGIN }, payload: body });
    expect(first.statusCode).toBe(200);
    const code = first.json().dev_code as string;
    await active.app.inject({ method: 'POST', url: '/console/api/auth/register/verify', headers: { origin: CONSOLE_ORIGIN }, payload: { email: body.email, code } });

    // Re-registering an active account answers the same success shape, no second row.
    const second = await active.app.inject({ method: 'POST', url: '/console/api/auth/register', headers: { origin: CONSOLE_ORIGIN }, payload: body });
    expect(second.statusCode).toBe(200);
    const count = active.db.db.prepare("SELECT COUNT(*) AS c FROM accounts WHERE email='dup@example.test'").get() as { c: number };
    expect(count.c).toBe(1);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/console-auth-register.test.ts`
Expected: FAIL — 404 (route not registered).

- [x] **Step 3: Add the allowlist entry**

In `src/policy/allowlist.ts`, replace the existing auth POST pattern:

```ts
  { method: 'POST', pattern: /^\/console\/api\/auth\/(request-code|verify-code|logout|register|register\/verify|login\/password|login\/verify|password\/request-reset|password\/reset|password\/set)$/, id: 'console.auth' },
```

(This single alternation covers all new auth routes added across Tasks 3–5, so later tasks do not touch this line again.)

- [x] **Step 4: Add DOCUMENTED_OPERATIONS entries**

In `src/policy/allowlist.ts`, after the existing `logout` entry in `DOCUMENTED_OPERATIONS`, add:

```ts
  { method: 'POST', path: '/console/api/auth/register', sample: '/console/api/auth/register', id: 'console.auth' },
  { method: 'POST', path: '/console/api/auth/register/verify', sample: '/console/api/auth/register/verify', id: 'console.auth' },
  { method: 'POST', path: '/console/api/auth/login/password', sample: '/console/api/auth/login/password', id: 'console.auth' },
  { method: 'POST', path: '/console/api/auth/login/verify', sample: '/console/api/auth/login/verify', id: 'console.auth' },
  { method: 'POST', path: '/console/api/auth/password/request-reset', sample: '/console/api/auth/password/request-reset', id: 'console.auth' },
  { method: 'POST', path: '/console/api/auth/password/reset', sample: '/console/api/auth/password/reset', id: 'console.auth' },
  { method: 'POST', path: '/console/api/auth/password/set', sample: '/console/api/auth/password/set', id: 'console.auth' },
```

- [x] **Step 5: Add OpenAPI paths**

In `docs/api/openapi.yaml`, after the `/console/api/auth/logout` block, add (keep the two-space path / four-space method layout the contract test parses):

```yaml
  /console/api/auth/register:
    post:
      summary: Begin account registration
      description: >-
        Validates name, email, password, and confirmation, creates a pending
        account, and dispatches a verification code. Requires an allowed Origin.
        Returns a generic success shape whether or not the email is new.
      responses:
        '200':
          description: Verification code dispatched.
        '400':
          description: Payload invalid.
        '403':
          description: Origin is not allowed.
  /console/api/auth/register/verify:
    post:
      summary: Complete registration with the emailed code
      description: Requires an allowed Origin. Issues the session cookie on success.
      responses:
        '200':
          description: Account verified and session cookie issued.
        '401':
          description: Code invalid or expired.
        '403':
          description: Origin is not allowed.
  /console/api/auth/login/password:
    post:
      summary: Begin password sign-in
      description: >-
        Verifies the password and, on success, dispatches a second-factor code.
        Requires an allowed Origin. Uses a generic failure for unknown email,
        wrong password, and passwordless accounts.
      responses:
        '200':
          description: Second-factor code dispatched.
        '401':
          description: Generic credential failure.
        '403':
          description: Origin is not allowed.
  /console/api/auth/login/verify:
    post:
      summary: Complete password sign-in with the emailed code
      description: Requires an allowed Origin. Issues the session cookie on success.
      responses:
        '200':
          description: Session cookie issued.
        '401':
          description: Code invalid or expired.
        '403':
          description: Origin is not allowed.
  /console/api/auth/password/request-reset:
    post:
      summary: Request a password reset code
      description: >-
        Always answers with the same generic success shape so an email's
        existence is never revealed. Requires an allowed Origin.
      responses:
        '200':
          description: Generic success.
        '403':
          description: Origin is not allowed.
  /console/api/auth/password/reset:
    post:
      summary: Replace a password using a reset code
      description: Requires an allowed Origin.
      responses:
        '200':
          description: Password replaced.
        '400':
          description: Payload invalid.
        '401':
          description: Code invalid or expired.
        '403':
          description: Origin is not allowed.
  /console/api/auth/password/set:
    post:
      summary: Set a password for a signed-in legacy account
      security:
        - sessionCookie: []
      description: Requires a session and an allowed Origin.
      responses:
        '200':
          description: Password stored.
        '400':
          description: Payload invalid.
        '401':
          description: Session required.
        '403':
          description: Origin is not allowed.
```

- [x] **Step 6: Add the register schemas and routes**

In `src/http/console.ts`, add imports at the top:

```ts
import { hashPassword, validatePasswordStrength } from '../accounts/passwords.js';
```

Add schemas near the other `z` schemas:

```ts
const registerSchema = z
  .object({
    name: z.string().min(1).max(120),
    email: z.string().email().max(254),
    password: z.string().min(1).max(256),
    confirmPassword: z.string().min(1).max(256)
  })
  .strict();
```

Add a shared OTP delivery helper (place near `request-code`) so register/login/reset reuse the existing webhook/SMTP/dev delivery logic. Extract the delivery body of the existing `request-code` handler into:

```ts
  async function deliverCode(email: string, reply: FastifyReply, traceId: string) {
    const code = accounts.issueCode(email, 'login', config.OTP_TTL_MINUTES, config.OTP_RESEND_SECONDS);
    return sendCode(code, email, reply, traceId);
  }
```

and a purpose-parameterised variant used by the new routes:

```ts
  async function issueAndDeliver(
    email: string,
    purpose: 'login' | 'register' | 'reset',
    reply: FastifyReply
  ) {
    const code = accounts.issueCode(email, purpose, config.OTP_TTL_MINUTES, config.OTP_RESEND_SECONDS);
    if (config.OTP_DELIVERY === 'webhook' && config.OTP_WEBHOOK_URL) {
      const target = await assertResolvedPublicEgress(config.OTP_WEBHOOK_URL);
      const delivery = await fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.OTP_WEBHOOK_TOKEN ? { authorization: `Bearer ${config.OTP_WEBHOOK_TOKEN}` } : {})
        },
        body: JSON.stringify({ email: normaliseEmail(email), code, ttl_minutes: config.OTP_TTL_MINUTES }),
        signal: AbortSignal.timeout(8000)
      });
      if (!delivery.ok) throw new AccountError('otp_delivery_failed', 502);
      return reply.send({ delivered: true, ttl_minutes: config.OTP_TTL_MINUTES });
    }
    if (config.OTP_DELIVERY === 'smtp') {
      let transport: ReturnType<typeof createSmtpTransport> | undefined;
      try {
        transport = createSmtpTransport(config);
        await sendOtpMail(transport, {
          from: config.SMTP_FROM as string,
          to: normaliseEmail(email),
          code,
          ttlMinutes: config.OTP_TTL_MINUTES
        });
      } catch {
        throw new AccountError('otp_delivery_failed', 502);
      } finally {
        transport?.close?.();
      }
      return reply.send({ delivered: true, ttl_minutes: config.OTP_TTL_MINUTES });
    }
    return reply.send({ delivered: false, ttl_minutes: config.OTP_TTL_MINUTES, dev_code: code });
  }
```

Refactor the existing `request-code` handler to call `issueAndDeliver(parsed.data.email, 'login', reply)` inside its try block (preserving its current error handling). Then add the register routes after `verify-code`:

```ts
  app.post('/console/api/auth/register', async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_request', 'All fields are required', req.id);
    const { name, email, password, confirmPassword } = parsed.data;
    if (password !== confirmPassword) {
      return fail(reply, 400, 'invalid_request', 'Passwords do not match', req.id);
    }
    const weakness = validatePasswordStrength(password);
    if (weakness) return fail(reply, 400, 'invalid_request', weakness, req.id);
    try {
      const existing = accounts.findByEmail(email);
      if (existing) {
        if (existing.emailVerifiedAt !== null) {
          // Already active: answer the same success shape without sending a
          // code, so the response never reveals that the email is registered.
          return reply.send({ delivered: true, ttl_minutes: config.OTP_TTL_MINUTES });
        }
        // Pending registration: refresh the credential and re-issue the code.
        accounts.setPassword(existing.id, hashPassword(password));
        if (name) {
          db.db.prepare('UPDATE accounts SET display_name = ? WHERE id = ?').run(name.slice(0, 120), existing.id);
        }
        return issueAndDeliver(email, 'register', reply);
      }
      const account = accounts.create({ email, displayName: name });
      accounts.setPassword(account.id, hashPassword(password));
      return issueAndDeliver(email, 'register', reply);
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.post('/console/api/auth/register/verify', async (req, reply) => {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Code is invalid', req.id);
    try {
      const ok = accounts.consumeCode(parsed.data.email, parsed.data.code, 'register', config.OTP_MAX_ATTEMPTS);
      if (!ok) return fail(reply, 401, 'code_invalid', 'Code is invalid or expired', req.id);
      const account = accounts.findByEmail(parsed.data.email);
      if (!account || account.passwordHash !== null || !accounts.hasPassword(account.id)) {
        return fail(reply, 401, 'code_invalid', 'Code is invalid or expired', req.id);
      }
      if (account.status !== 'active') return fail(reply, 403, 'account_suspended', 'Account is suspended', req.id);
      accounts.markEmailVerified(account.id);
      accounts.linkIdentity(account.id, 'email', normaliseEmail(parsed.data.email));
      const token = accounts.createSession(account.id, config.SESSION_TTL_HOURS);
      setSessionCookie(reply, config, token);
      db.audit({
        tenantId: account.tenantId,
        actorType: 'account',
        event: 'console.register',
        traceId: req.id,
        metadata: { method: 'password' }
      });
      return reply.send({ authenticated: true, role: account.role });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });
```

- [x] **Step 7: Run the register test to verify it passes**

Run: `npx vitest run tests/console-auth-register.test.ts tests/openapi-contract.test.ts`
Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add src/http/console.ts src/policy/allowlist.ts docs/api/openapi.yaml tests/console-auth-register.test.ts
git commit -m "feat(auth): registration with password and OTP verification"
```

---

## Task 4: Password login routes (login/password + login/verify)

**Files:**
- Modify: `src/http/console.ts`
- Test: `tests/console-auth-login.test.ts`

**Interfaces:**
- Consumes: `verifyPassword` (Task 1), `AccountStore.getPasswordHash/hasPassword/consumeCode` (Task 2), `issueAndDeliver` (Task 3).
- Produces: `POST /console/api/auth/login/password` → `{ otp_required: true; ttl_minutes: number; dev_code?: string }`; `POST /console/api/auth/login/verify` → `{ authenticated: true; role: string }` + session cookie.

- [x] **Step 1: Write the failing test**

Create `tests/console-auth-login.test.ts` (reuse the same `start()`/`buildDist()` helpers as Task 3's test file):

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts/store.js';
import { hashPassword } from '../src/accounts/passwords.js';
import { createHarness, jsonResponse, testConfig, type Harness } from './support/harness.js';

const CONSOLE_ORIGIN = 'http://127.0.0.1:2080';
let harness: Harness | null = null;
let distRoot: string | null = null;

afterEach(async () => {
  if (harness) { await harness.cleanup(); harness = null; }
  if (distRoot) { rmSync(distRoot, { recursive: true, force: true }); distRoot = null; }
});

function buildDist(): string {
  const root = mkdtempSync(join(tmpdir(), 'lwrr-dist-'));
  distRoot = root;
  mkdirSync(join(root, 'assets'), { recursive: true });
  for (const page of ['index', 'login', 'member']) writeFileSync(join(root, `${page}.html`), '<!doctype html>', 'utf8');
  return root;
}

function start(): Harness {
  harness = createHarness(jsonResponse, { CONSOLE_ENABLED: true, WEB_DIST_PATH: buildDist() });
  return harness;
}

function seedPasswordAccount(active: Harness, email = 'pwuser@example.test') {
  const accounts = new AccountStore(active.db.db, testConfig.API_KEY_PEPPER);
  const account = accounts.create({ email, displayName: 'Pw User' });
  accounts.setPassword(account.id, hashPassword('a-very-strong-passphrase-1'));
  accounts.markEmailVerified(account.id);
  return account;
}

describe('console password login', () => {
  it('requires both a valid password and a valid OTP', async () => {
    const active = start();
    seedPasswordAccount(active);

    const step1 = await active.app.inject({
      method: 'POST', url: '/console/api/auth/login/password', headers: { origin: CONSOLE_ORIGIN },
      payload: { email: 'pwuser@example.test', password: 'a-very-strong-passphrase-1' }
    });
    expect(step1.statusCode).toBe(200);
    const code = step1.json().dev_code as string;
    expect(code).toMatch(/^[0-9]{6}$/);
    expect(step1.headers['set-cookie']).toBeUndefined();

    const step2 = await active.app.inject({
      method: 'POST', url: '/console/api/auth/login/verify', headers: { origin: CONSOLE_ORIGIN },
      payload: { email: 'pwuser@example.test', code }
    });
    expect(step2.statusCode).toBe(200);
    expect(step2.json().authenticated).toBe(true);
    expect(step2.headers['set-cookie']).toContain(testConfig.SESSION_COOKIE_NAME);
  });

  it('returns one generic failure for wrong password, unknown email, and passwordless accounts', async () => {
    const active = start();
    seedPasswordAccount(active);

    const wrong = await active.app.inject({
      method: 'POST', url: '/console/api/auth/login/password', headers: { origin: CONSOLE_ORIGIN },
      payload: { email: 'pwuser@example.test', password: 'the-wrong-passphrase-999' }
    });
    const unknown = await active.app.inject({
      method: 'POST', url: '/console/api/auth/login/password', headers: { origin: CONSOLE_ORIGIN },
      payload: { email: 'ghost@example.test', password: 'a-very-strong-passphrase-1' }
    });
    const passwordless = await active.app.inject({
      method: 'POST', url: '/console/api/auth/login/password', headers: { origin: CONSOLE_ORIGIN },
      payload: { email: 'harness@example.test', password: 'a-very-strong-passphrase-1' }
    });
    for (const response of [wrong, unknown, passwordless]) {
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('credential_invalid');
    }
  });

  it('rejects a login OTP that was never preceded by a password check', async () => {
    const active = start();
    seedPasswordAccount(active);
    const response = await active.app.inject({
      method: 'POST', url: '/console/api/auth/login/verify', headers: { origin: CONSOLE_ORIGIN },
      payload: { email: 'pwuser@example.test', code: '000000' }
    });
    expect(response.statusCode).toBe(401);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/console-auth-login.test.ts`
Expected: FAIL — 404.

- [x] **Step 3: Add the login schemas and routes**

In `src/http/console.ts`, add the schema:

```ts
const passwordLoginSchema = z
  .object({ email: z.string().email().max(254), password: z.string().min(1).max(256) })
  .strict();
```

Add the routes after `register/verify`:

```ts
  app.post('/console/api/auth/login/password', async (req, reply) => {
    const parsed = passwordLoginSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 401, 'credential_invalid', 'Email or password is incorrect', req.id);
    try {
      const account = accounts.findByEmail(parsed.data.email);
      const storedHash = account ? accounts.getPasswordHash(account.id) : null;
      // Verify against a dummy hash when the account or password is absent so the
      // response timing does not reveal whether the email exists.
      const ok = storedHash
        ? verifyPassword(parsed.data.password, storedHash)
        : verifyPassword(parsed.data.password, DUMMY_PASSWORD_HASH);
      if (!account || !ok || storedHash === null || account.status !== 'active' || account.emailVerifiedAt === null) {
        return fail(reply, 401, 'credential_invalid', 'Email or password is incorrect', req.id);
      }
      return issueAndDeliver(parsed.data.email, 'login', reply);
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.post('/console/api/auth/login/verify', async (req, reply) => {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Code is invalid', req.id);
    try {
      const ok = accounts.consumeCode(parsed.data.email, parsed.data.code, 'login', config.OTP_MAX_ATTEMPTS);
      if (!ok) return fail(reply, 401, 'code_invalid', 'Code is invalid or expired', req.id);
      const account = accounts.findByEmail(parsed.data.email);
      if (!account || account.status !== 'active' || account.emailVerifiedAt === null) {
        return fail(reply, 401, 'code_invalid', 'Code is invalid or expired', req.id);
      }
      accounts.linkIdentity(account.id, 'email', normaliseEmail(parsed.data.email));
      const token = accounts.createSession(account.id, config.SESSION_TTL_HOURS);
      setSessionCookie(reply, config, token);
      db.audit({
        tenantId: account.tenantId,
        actorType: 'account',
        event: 'console.login',
        traceId: req.id,
        metadata: { method: 'password' }
      });
      return reply.send({ authenticated: true, role: account.role });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });
```

Add the module-level dummy hash constant (near the top of `registerConsole`, or module scope) so the timing equaliser has a real scrypt target:

```ts
/** Pre-computed once; used only to equalise timing when the account is absent. */
const DUMMY_PASSWORD_HASH = hashPassword('leuwongrr-timing-equaliser');
```

Add `verifyPassword` to the passwords import from Task 3:

```ts
import { hashPassword, validatePasswordStrength, verifyPassword } from '../accounts/passwords.js';
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/console-auth-login.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/http/console.ts tests/console-auth-login.test.ts
git commit -m "feat(auth): password login with OTP second factor"
```

---

## Task 5: Password reset + authenticated set-password routes

**Files:**
- Modify: `src/http/console.ts`
- Test: `tests/console-auth-reset.test.ts`

**Interfaces:**
- Consumes: `hashPassword`, `validatePasswordStrength` (Task 1), `AccountStore.consumeCode/setPassword/hasPassword` (Task 2), `issueAndDeliver`, `currentAccount` (existing).
- Produces: `POST /console/api/auth/password/request-reset` → generic `{ delivered: true; ttl_minutes: number }`; `POST /console/api/auth/password/reset` → `{ reset: true }`; `POST /console/api/auth/password/set` → `{ set: true }`. Also extends `/console/api/session` and `/console/api/member/overview` account payloads with `has_password: boolean`.

- [x] **Step 1: Write the failing test**

Create `tests/console-auth-reset.test.ts` (same harness helpers as Tasks 3–4):

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts/store.js';
import { verifyPassword } from '../src/accounts/passwords.js';
import { createHarness, jsonResponse, testConfig, type Harness } from './support/harness.js';

const CONSOLE_ORIGIN = 'http://127.0.0.1:2080';
let harness: Harness | null = null;
let distRoot: string | null = null;

afterEach(async () => {
  if (harness) { await harness.cleanup(); harness = null; }
  if (distRoot) { rmSync(distRoot, { recursive: true, force: true }); distRoot = null; }
});

function buildDist(): string {
  const root = mkdtempSync(join(tmpdir(), 'lwrr-dist-'));
  distRoot = root;
  mkdirSync(join(root, 'assets'), { recursive: true });
  for (const page of ['index', 'login', 'member']) writeFileSync(join(root, `${page}.html`), '<!doctype html>', 'utf8');
  return root;
}

function start(): Harness {
  harness = createHarness(jsonResponse, { CONSOLE_ENABLED: true, WEB_DIST_PATH: buildDist() });
  return harness;
}

function signIn(active: Harness, email = 'legacy@example.test') {
  const accounts = new AccountStore(active.db.db, testConfig.API_KEY_PEPPER);
  const account = accounts.create({ email });
  accounts.markEmailVerified(account.id);
  const token = accounts.createSession(account.id, testConfig.SESSION_TTL_HOURS);
  return { account, cookie: `${testConfig.SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` };
}

const STRONG = 'a-very-strong-passphrase-1';

describe('password reset', () => {
  it('answers generically for unknown emails and resets a known one', async () => {
    const active = start();
    const { account } = signIn(active, 'resetme@example.test');

    const unknown = await active.app.inject({
      method: 'POST', url: '/console/api/auth/password/request-reset', headers: { origin: CONSOLE_ORIGIN },
      payload: { email: 'ghost@example.test' }
    });
    expect(unknown.statusCode).toBe(200);

    const requested = await active.app.inject({
      method: 'POST', url: '/console/api/auth/password/request-reset', headers: { origin: CONSOLE_ORIGIN },
      payload: { email: 'resetme@example.test' }
    });
    expect(requested.statusCode).toBe(200);
    const code = requested.json().dev_code as string;

    const done = await active.app.inject({
      method: 'POST', url: '/console/api/auth/password/reset', headers: { origin: CONSOLE_ORIGIN },
      payload: { email: 'resetme@example.test', code, password: STRONG, confirmPassword: STRONG }
    });
    expect(done.statusCode).toBe(200);
    const raw = active.db.db.prepare('SELECT password_hash FROM accounts WHERE id=?').get(account.id) as { password_hash: string };
    expect(verifyPassword(STRONG, raw.password_hash)).toBe(true);
  });

  it('rejects a reset with a wrong code', async () => {
    const active = start();
    signIn(active, 'resetme2@example.test');
    await active.app.inject({ method: 'POST', url: '/console/api/auth/password/request-reset', headers: { origin: CONSOLE_ORIGIN }, payload: { email: 'resetme2@example.test' } });
    const bad = await active.app.inject({
      method: 'POST', url: '/console/api/auth/password/reset', headers: { origin: CONSOLE_ORIGIN },
      payload: { email: 'resetme2@example.test', code: '000000', password: STRONG, confirmPassword: STRONG }
    });
    expect(bad.statusCode).toBe(401);
  });
});

describe('authenticated set-password for legacy accounts', () => {
  it('lets a signed-in passwordless member set a password once', async () => {
    const active = start();
    const { account, cookie } = signIn(active);
    const response = await active.app.inject({
      method: 'POST', url: '/console/api/auth/password/set', headers: { cookie, origin: CONSOLE_ORIGIN },
      payload: { password: STRONG, confirmPassword: STRONG }
    });
    expect(response.statusCode).toBe(200);
    const raw = active.db.db.prepare('SELECT password_hash FROM accounts WHERE id=?').get(account.id) as { password_hash: string };
    expect(verifyPassword(STRONG, raw.password_hash)).toBe(true);
  });

  it('requires a session', async () => {
    const active = start();
    const response = await active.app.inject({
      method: 'POST', url: '/console/api/auth/password/set', headers: { origin: CONSOLE_ORIGIN },
      payload: { password: STRONG, confirmPassword: STRONG }
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('session exposes has_password', () => {
  it('reports false for a passwordless member and true after set', async () => {
    const active = start();
    const { cookie } = signIn(active);
    const before = await active.app.inject({ method: 'GET', url: '/console/api/session', headers: { cookie } });
    expect(before.json().account.has_password).toBe(false);
    await active.app.inject({ method: 'POST', url: '/console/api/auth/password/set', headers: { cookie, origin: CONSOLE_ORIGIN }, payload: { password: STRONG, confirmPassword: STRONG } });
    const after = await active.app.inject({ method: 'GET', url: '/console/api/session', headers: { cookie } });
    expect(after.json().account.has_password).toBe(true);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/console-auth-reset.test.ts`
Expected: FAIL — 404 / missing `has_password`.

- [x] **Step 3: Add reset/set schemas and routes**

In `src/http/console.ts`, add schemas:

```ts
const resetRequestSchema = z.object({ email: z.string().email().max(254) }).strict();
const resetSchema = z
  .object({
    email: z.string().email().max(254),
    code: z.string().regex(/^[0-9]{6}$/),
    password: z.string().min(1).max(256),
    confirmPassword: z.string().min(1).max(256)
  })
  .strict();
const setPasswordSchema = z
  .object({ password: z.string().min(1).max(256), confirmPassword: z.string().min(1).max(256) })
  .strict();
```

Add the routes after `login/verify`:

```ts
  app.post('/console/api/auth/password/request-reset', async (req, reply) => {
    const parsed = resetRequestSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Email is required', req.id);
    try {
      const account = accounts.findByEmail(parsed.data.email);
      if (!account || account.status !== 'active') {
        // Generic success; never reveal whether the email exists.
        return reply.send({ delivered: true, ttl_minutes: config.OTP_TTL_MINUTES });
      }
      return issueAndDeliver(parsed.data.email, 'reset', reply);
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.post('/console/api/auth/password/reset', async (req, reply) => {
    const parsed = resetSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_request', 'All fields are required', req.id);
    if (parsed.data.password !== parsed.data.confirmPassword) {
      return fail(reply, 400, 'invalid_request', 'Passwords do not match', req.id);
    }
    const weakness = validatePasswordStrength(parsed.data.password);
    if (weakness) return fail(reply, 400, 'invalid_request', weakness, req.id);
    try {
      const ok = accounts.consumeCode(parsed.data.email, parsed.data.code, 'reset', config.OTP_MAX_ATTEMPTS);
      if (!ok) return fail(reply, 401, 'code_invalid', 'Code is invalid or expired', req.id);
      const account = accounts.findByEmail(parsed.data.email);
      if (!account || account.status !== 'active') {
        return fail(reply, 401, 'code_invalid', 'Code is invalid or expired', req.id);
      }
      accounts.setPassword(account.id, hashPassword(parsed.data.password));
      accounts.markEmailVerified(account.id);
      db.audit({
        tenantId: account.tenantId,
        actorType: 'account',
        event: 'console.password.reset',
        traceId: req.id,
        metadata: { method: 'otp' }
      });
      return reply.send({ reset: true });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.post('/console/api/auth/password/set', async (req, reply) => {
    try {
      const account = requireMember(await currentAccount(req));
      const parsed = setPasswordSchema.safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, 'invalid_request', 'All fields are required', req.id);
      if (parsed.data.password !== parsed.data.confirmPassword) {
        return fail(reply, 400, 'invalid_request', 'Passwords do not match', req.id);
      }
      const weakness = validatePasswordStrength(parsed.data.password);
      if (weakness) return fail(reply, 400, 'invalid_request', weakness, req.id);
      accounts.setPassword(account.id, hashPassword(parsed.data.password));
      db.audit({
        tenantId: account.tenantId,
        actorType: 'account',
        event: 'console.password.set',
        traceId: req.id,
        metadata: { method: 'session' }
      });
      return reply.send({ set: true });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });
```

- [x] **Step 4: Add `has_password` to session and member overview**

In the `/console/api/session` handler, extend the `account` object:

```ts
      account: account
        ? {
            email: account.email,
            display_name: account.displayName,
            role: account.role,
            tenant_id: account.tenantId,
            has_password: accounts.hasPassword(account.id)
          }
        : null,
```

In the `/console/api/member/overview` handler, extend the returned `account`:

```ts
        account: {
          email: account.email,
          display_name: account.displayName,
          role: account.role,
          has_password: accounts.hasPassword(account.id)
        },
```

- [x] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/console-auth-reset.test.ts`
Expected: PASS.

- [x] **Step 6: Run the full backend suite**

Run: `npm test`
Expected: PASS (all backend + DOM projects).

- [x] **Step 7: Commit**

```bash
git add src/http/console.ts tests/console-auth-reset.test.ts
git commit -m "feat(auth): password reset and authenticated set-password"
```

---

## Task 6: Frontend API client additions

**Files:**
- Modify: `web/src/lib/api.ts`

**Interfaces:**
- Consumes: the routes from Tasks 3–5.
- Produces: `api.register`, `api.registerVerify`, `api.loginPassword`, `api.loginVerify`, `api.requestReset`, `api.resetPassword`, `api.setPassword`; `SessionState.account.has_password`.

- [x] **Step 1: Extend `SessionState`**

In `web/src/lib/api.ts`, update the `SessionState` interface's `account` type:

```ts
export interface SessionState {
  authenticated: boolean;
  account: {
    email: string;
    display_name: string;
    role: string;
    tenant_id: string;
    has_password: boolean;
  } | null;
  providers: {
    google: boolean;
    discord: boolean;
    telegram: boolean;
    telegram_bot: string | null;
  };
}
```

- [x] **Step 2: Add the auth methods**

In the `api` object, after `verifyCode`, add:

```ts
  register: (input: { name: string; email: string; password: string; confirmPassword: string }) =>
    post<{ delivered: boolean; ttl_minutes: number; dev_code?: string }>(
      '/console/api/auth/register',
      input
    ),
  registerVerify: (email: string, code: string) =>
    post<{ authenticated: boolean; role: string }>('/console/api/auth/register/verify', { email, code }),
  loginPassword: (email: string, password: string) =>
    post<{ otp_required?: boolean; delivered: boolean; ttl_minutes: number; dev_code?: string }>(
      '/console/api/auth/login/password',
      { email, password }
    ),
  loginVerify: (email: string, code: string) =>
    post<{ authenticated: boolean; role: string }>('/console/api/auth/login/verify', { email, code }),
  requestReset: (email: string) =>
    post<{ delivered: boolean; ttl_minutes: number }>('/console/api/auth/password/request-reset', { email }),
  resetPassword: (input: { email: string; code: string; password: string; confirmPassword: string }) =>
    post<{ reset: boolean }>('/console/api/auth/password/reset', input),
  setPassword: (input: { password: string; confirmPassword: string }) =>
    post<{ set: boolean }>('/console/api/auth/password/set', input),
```

- [x] **Step 3: Typecheck the web project**

Run: `npm --prefix web run build`
Expected: build succeeds (tsc --noEmit + vite build).

- [x] **Step 4: Commit**

```bash
git add web/src/lib/api.ts
git commit -m "feat(console): client methods for password and OTP auth"
```

---

## Task 7: PasswordInput component with accessible eye toggle

**Files:**
- Create: `web/src/components/password-input.tsx`
- Test: `web/src/components/password-input.dom.test.tsx`

**Interfaces:**
- Produces: `<PasswordInput value onChange placeholder autoComplete label hint />` — a controlled password field whose visibility toggle changes only `type`, preserves the value, and exposes `aria-pressed` + `aria-label`.

- [x] **Step 1: Write the failing DOM test**

Create `web/src/components/password-input.dom.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { PasswordInput } from './password-input';

afterEach(cleanup);

function Harness() {
  const [value, setValue] = useState('');
  return <PasswordInput label="Password" value={value} onChange={setValue} autoComplete="new-password" />;
}

describe('PasswordInput', () => {
  it('masks by default and reveals on toggle without losing the value', async () => {
    render(<Harness />);
    const input = screen.getByLabelText('Password') as HTMLInputElement;
    await userEvent.type(input, 'hunter2secret');
    expect(input.type).toBe('password');

    const toggle = screen.getByRole('button', { name: /show password/i });
    await userEvent.click(toggle);
    expect(input.type).toBe('text');
    expect(input.value).toBe('hunter2secret');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');

    await userEvent.click(toggle);
    expect(input.type).toBe('password');
    expect(input.value).toBe('hunter2secret');
  });

  it('keeps the toggle keyboard operable', async () => {
    render(<Harness />);
    const toggle = screen.getByRole('button', { name: /show password/i });
    toggle.focus();
    await userEvent.keyboard('{Enter}');
    expect((screen.getByLabelText('Password') as HTMLInputElement).type).toBe('text');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/src/components/password-input.dom.test.tsx`
Expected: FAIL — cannot resolve `./password-input`.

- [x] **Step 3: Write the component**

Create `web/src/components/password-input.tsx`:

```tsx
import { useState } from 'react';
import { Icon } from './icons';
import { inputClass } from './ui';

/**
 * A controlled password field with an accessible visibility toggle. The toggle
 * flips only the input's `type`; the value is never cleared or re-read, and the
 * button reports its state through aria-pressed so screen readers announce it.
 */
export function PasswordInput({
  label,
  value,
  onChange,
  placeholder,
  autoComplete,
  hint
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete?: string;
  hint?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
      <span className="relative block">
        <input
          className={`${inputClass} pr-11`}
          type={visible ? 'text' : 'password'}
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          className="focus-ring absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-muted transition-colors hover:text-ink"
        >
          <Icon name={visible ? 'eyeOff' : 'eye'} size={16} />
        </button>
      </span>
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run web/src/components/password-input.dom.test.tsx`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add web/src/components/password-input.tsx web/src/components/password-input.dom.test.tsx
git commit -m "feat(console): accessible password input with visibility toggle"
```

---

## Task 8: Rewrite `/login` as a focused auth shell

**Files:**
- Modify: `web/src/login/main.tsx` (full rewrite)
- Test: `web/src/login/login.dom.test.tsx`

**Interfaces:**
- Consumes: `api.register/registerVerify/loginPassword/loginVerify/requestCode/verifyCode/requestReset/resetPassword/setPassword` (Task 6), `PasswordInput` (Task 7), `Button`, `Field`, `inputClass`, `ToastHost`, `useToast`, `Icon` (existing).
- Produces: a `/login` page with modes `signin`, `register`, `verify`, `forgot`, `reset`, and a legacy `set-password` prompt.

- [x] **Step 1: Write the failing DOM test**

Create `web/src/login/login.dom.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(public code: string, public status: number, message: string) { super(message); }
  },
  api: {
    session: vi.fn(async () => ({ authenticated: false, account: null, providers: { google: false, discord: false, telegram: false, telegram_bot: null } })),
    register: vi.fn(async () => ({ delivered: false, ttl_minutes: 10, dev_code: '123456' })),
    registerVerify: vi.fn(async () => ({ authenticated: true, role: 'member' })),
    loginPassword: vi.fn(async () => ({ delivered: false, ttl_minutes: 10, dev_code: '654321' })),
    loginVerify: vi.fn(async () => ({ authenticated: true, role: 'member' })),
    requestCode: vi.fn(async () => ({ delivered: false, ttl_minutes: 10, dev_code: '111111' })),
    verifyCode: vi.fn(async () => ({ authenticated: true, role: 'member' })),
    requestReset: vi.fn(async () => ({ delivered: true, ttl_minutes: 10 })),
    resetPassword: vi.fn(async () => ({ reset: true })),
    setPassword: vi.fn(async () => ({ set: true }))
  }
}));

import { App } from './main';

afterEach(cleanup);

describe('login shell', () => {
  it('shows the sign-in form with email and password by default', async () => {
    render(<App />);
    expect(await screen.findByLabelText(/email address/i)).toBeTruthy();
    expect(screen.getByLabelText(/^password$/i)).toBeTruthy();
  });

  it('switches to registration with name, email, password, and confirmation', async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /create account/i }));
    expect(screen.getByLabelText(/full name/i)).toBeTruthy();
    expect(screen.getByLabelText(/confirm password/i)).toBeTruthy();
  });

  it('has a visible eye toggle on the password field', async () => {
    render(<App />);
    await screen.findByLabelText(/email address/i);
    expect(screen.getAllByRole('button', { name: /show password/i }).length).toBeGreaterThan(0);
  });

  it('offers a forgot-password path', async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /forgot password/i }));
    expect(screen.getByText(/reset your password/i)).toBeTruthy();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/src/login/login.dom.test.tsx`
Expected: FAIL — current `main.tsx` exports no `App` and renders a marketing page.

- [x] **Step 3: Rewrite `web/src/login/main.tsx`**

Replace the file with a focused auth shell. Export `App` (the test imports it) and keep the `createRoot` mount. The structure: a centred card with a mode state machine. Keep it dependency-light (no Motion). Full content:

```tsx
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError, type SessionState } from '../lib/api';
import { Icon } from '../components/icons';
import { LogoMark } from '../components/logo';
import { Button, Field, inputClass, ToastHost, useToast } from '../components/ui';
import { PasswordInput } from '../components/password-input';
import '../styles.css';

type Mode = 'signin' | 'register' | 'verify' | 'forgot' | 'reset' | 'otp';

const MIN_PASSWORD = 12;

export function App() {
  const toast = useToast();
  const [session, setSession] = useState<SessionState | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<Mode>('signin');
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  // Which flow the OTP step belongs to: registration or password sign-in.
  const [otpFlow, setOtpFlow] = useState<'register' | 'login'>('login');
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    api.session().then(setSession).catch(() => setSession(null)).finally(() => setReady(true));
  }, []);
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  function fail(error: unknown, fallback: string) {
    toast(error instanceof ApiError ? error.message : fallback, 'bad');
  }

  async function submitRegister() {
    if (password !== confirm) return toast('Passwords do not match', 'bad');
    if (password.length < MIN_PASSWORD) return toast(`Password must be at least ${MIN_PASSWORD} characters.`, 'bad');
    setBusy(true);
    try {
      const result = await api.register({ name, email, password, confirmPassword: confirm });
      setOtpFlow('register');
      setMode('otp');
      setCooldown(60);
      toast(result.dev_code ? `Development code: ${result.dev_code}` : `Code sent. Valid for ${result.ttl_minutes} minutes.`);
    } catch (error) { fail(error, 'Could not start registration'); }
    finally { setBusy(false); }
  }

  async function submitLogin() {
    setBusy(true);
    try {
      const result = await api.loginPassword(email, password);
      setOtpFlow('login');
      setMode('otp');
      setCooldown(60);
      toast(result.dev_code ? `Development code: ${result.dev_code}` : `Code sent. Valid for ${result.ttl_minutes} minutes.`);
    } catch (error) { fail(error, 'Email or password is incorrect'); }
    finally { setBusy(false); }
  }

  async function submitOtp() {
    setBusy(true);
    try {
      if (otpFlow === 'register') await api.registerVerify(email, code);
      else await api.loginVerify(email, code);
      window.location.href = '/member';
    } catch (error) { fail(error, 'Code rejected'); }
    finally { setBusy(false); }
  }

  async function submitForgot() {
    setBusy(true);
    try {
      await api.requestReset(email);
      setMode('reset');
      toast('If that address exists, a reset code is on its way.');
    } catch (error) { fail(error, 'Could not request a reset'); }
    finally { setBusy(false); }
  }

  async function submitReset() {
    if (password !== confirm) return toast('Passwords do not match', 'bad');
    if (password.length < MIN_PASSWORD) return toast(`Password must be at least ${MIN_PASSWORD} characters.`, 'bad');
    setBusy(true);
    try {
      await api.resetPassword({ email, code, password, confirmPassword: confirm });
      toast('Password updated. Sign in with your new password.');
      setMode('signin');
      setPassword('');
      setConfirm('');
      setCode('');
    } catch (error) { fail(error, 'Could not reset the password'); }
    finally { setBusy(false); }
  }

  const oauth = ready && session && (session.providers.google || session.providers.discord);

  return (
    <div className="flex min-h-full items-center justify-center bg-canvas px-4 py-10 text-ink">
      <main className="w-full max-w-md">
        <a href="/" className="focus-ring mb-6 flex items-center justify-center gap-2 rounded-lg">
          <LogoMark size={28} />
          <span className="font-semibold tracking-tight">LeuwongRR Gateway</span>
        </a>

        <section className="rounded-card border border-border bg-surface p-6 shadow-card" aria-labelledby="auth-title">
          {!ready ? (
            <p className="py-10 text-center text-sm text-muted">Preparing authentication…</p>
          ) : (
            <>
              <h1 id="auth-title" className="text-lg font-semibold tracking-tight">
                {mode === 'register' ? 'Create your account'
                  : mode === 'otp' ? 'Enter your verification code'
                  : mode === 'forgot' ? 'Reset your password'
                  : mode === 'reset' ? 'Choose a new password'
                  : 'Sign in to the console'}
              </h1>
              <p className="mt-1 text-xs text-muted">
                {mode === 'register' ? 'Name, email, and a strong password, then a one-time code.'
                  : mode === 'otp' ? `We sent a six-digit code to ${email}.`
                  : mode === 'forgot' ? 'We will email you a one-time reset code.'
                  : mode === 'reset' ? 'Enter the code and your new password.'
                  : 'Password plus a one-time code. No password? Use a one-time email code.'}
              </p>

              {mode === 'signin' && (
                <form className="mt-5 space-y-3" onSubmit={(event) => { event.preventDefault(); void submitLogin(); }}>
                  <Field label="Email address">
                    <input className={inputClass} type="email" inputMode="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
                  </Field>
                  <PasswordInput label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
                  <Button type="submit" busy={busy} className="w-full">Continue</Button>
                  <div className="flex justify-between text-xs text-muted">
                    <button type="button" className="focus-ring min-h-[44px] rounded hover:text-ink" onClick={() => setMode('forgot')}>Forgot password?</button>
                    <button type="button" className="focus-ring min-h-[44px] rounded hover:text-ink" onClick={() => setMode('register')}>Create account</button>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted"><span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" /></div>
                  <Button type="button" variant="outline" className="w-full" onClick={() => { setOtpFlow('login'); setMode('otp'); void requestCodeOnly(); }}>Email me a one-time code</Button>
                </form>
              )}

              {mode === 'register' && (
                <form className="mt-5 space-y-3" onSubmit={(event) => { event.preventDefault(); void submitRegister(); }}>
                  <Field label="Full name">
                    <input className={inputClass} autoComplete="name" required value={name} onChange={(event) => setName(event.target.value)} placeholder="Ada Lovelace" />
                  </Field>
                  <Field label="Email address">
                    <input className={inputClass} type="email" inputMode="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
                  </Field>
                  <PasswordInput label="Password" value={password} onChange={setPassword} autoComplete="new-password" hint={`At least ${MIN_PASSWORD} characters.`} />
                  <PasswordInput label="Confirm password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
                  <Button type="submit" busy={busy} className="w-full">Create account</Button>
                  <p className="text-center text-xs text-muted">Already have an account? <button type="button" className="focus-ring rounded text-brand hover:underline" onClick={() => setMode('signin')}>Sign in</button></p>
                </form>
              )}

              {mode === 'otp' && (
                <form className="mt-5 space-y-3" onSubmit={(event) => { event.preventDefault(); void submitOtp(); }}>
                  <Field label="Verification code" hint={`Sent to ${email}`}>
                    <input className={`${inputClass} text-center text-lg tracking-[0.4em]`} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ''))} />
                  </Field>
                  <Button type="submit" icon="check" busy={busy} className="w-full">Verify and continue</Button>
                  <div className="flex justify-between text-xs text-muted">
                    <button type="button" className="focus-ring min-h-[44px] rounded hover:text-ink" onClick={() => setMode(otpFlow === 'register' ? 'register' : 'signin')}>Back</button>
                    <button type="button" disabled={cooldown > 0 || busy} className="focus-ring min-h-[44px] rounded hover:text-ink disabled:opacity-50" onClick={() => void resend()}>{cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend'}</button>
                  </div>
                </form>
              )}

              {mode === 'forgot' && (
                <form className="mt-5 space-y-3" onSubmit={(event) => { event.preventDefault(); void submitForgot(); }}>
                  <Field label="Email address">
                    <input className={inputClass} type="email" inputMode="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
                  </Field>
                  <Button type="submit" busy={busy} className="w-full">Send reset code</Button>
                  <p className="text-center text-xs text-muted"><button type="button" className="focus-ring rounded text-brand hover:underline" onClick={() => setMode('signin')}>Back to sign in</button></p>
                </form>
              )}

              {mode === 'reset' && (
                <form className="mt-5 space-y-3" onSubmit={(event) => { event.preventDefault(); void submitReset(); }}>
                  <Field label="Reset code">
                    <input className={`${inputClass} text-center text-lg tracking-[0.4em]`} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ''))} />
                  </Field>
                  <PasswordInput label="New password" value={password} onChange={setPassword} autoComplete="new-password" hint={`At least ${MIN_PASSWORD} characters.`} />
                  <PasswordInput label="Confirm password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
                  <Button type="submit" busy={busy} className="w-full">Update password</Button>
                </form>
              )}

              {oauth && mode === 'signin' && (
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  {session!.providers.google && <Button variant="outline" onClick={() => (window.location.href = '/console/api/auth/start/google')}>Google</Button>}
                  {session!.providers.discord && <Button variant="outline" onClick={() => (window.location.href = '/console/api/auth/start/discord')}>Discord</Button>}
                </div>
              )}
            </>
          )}
        </section>

        <p className="mt-4 text-center text-xs text-muted">
          Prompts and completions are never logged. <a href="/" className="focus-ring rounded text-brand hover:underline">Back to site</a>
        </p>
      </main>
    </div>
  );

  async function requestCodeOnly() {
    try {
      const result = await api.requestCode(email);
      setCooldown(60);
      toast(result.dev_code ? `Development code: ${result.dev_code}` : `Code sent. Valid for ${result.ttl_minutes} minutes.`);
    } catch (error) { fail(error, 'Could not send the code'); }
  }

  async function resend() {
    if (otpFlow === 'register') {
      try { await api.register({ name, email, password, confirmPassword: confirm }); setCooldown(60); } catch (error) { fail(error, 'Could not resend'); }
    } else if (password) {
      try { await api.loginPassword(email, password); setCooldown(60); } catch (error) { fail(error, 'Could not resend'); }
    } else {
      await requestCodeOnly();
    }
  }
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ToastHost>
      <App />
    </ToastHost>
  </StrictMode>
);
```

Note: the test's `getByLabelText(/^password$/i)` matches the `PasswordInput` label "Password". The `Icon` import is retained only if used; remove it if the linter flags it as unused.

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run web/src/login/login.dom.test.tsx`
Expected: PASS.

- [x] **Step 5: Build the console**

Run: `npm --prefix web run build`
Expected: build succeeds.

- [x] **Step 6: Commit**

```bash
git add web/src/login/main.tsx web/src/login/login.dom.test.tsx
git commit -m "feat(console): focused login shell with register, OTP, and reset"
```

---

## Task 9: Portal `/` SEO refresh

**Files:**
- Modify: `web/index.html`
- Modify: `web/src/portal/landing-static.test.ts`

**Interfaces:**
- Produces: a canonical link, JSON-LD `Organization`/`WebSite` block, updated CTAs pointing at `/login`, and truthful copy. The static test asserts the new metadata.

- [x] **Step 1: Update the static test first**

In `web/src/portal/landing-static.test.ts`, extend the SEO test:

```ts
  it('declares a canonical URL and structured data', () => {
    expect(landing).toContain('<link rel="canonical" href="https://api.leuwongrr.cloud/" />');
    expect(landing).toContain('application/ld+json');
    expect(landing).toContain('"@type":"WebSite"');
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/src/portal/landing-static.test.ts`
Expected: FAIL — canonical/JSON-LD absent.

- [x] **Step 3: Update `web/index.html`**

In the `<head>`, after the existing `robots` meta, add:

```html
    <link rel="canonical" href="https://api.leuwongrr.cloud/" />
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "WebSite",
        "name": "LeuwongRR Gateway",
        "url": "https://api.leuwongrr.cloud/",
        "description": "A private OpenAI- and Anthropic-compatible AI API gateway with per-member keys, token budgets, and plan-based model access."
      }
    </script>
```

Update the hero CTA block so the primary action offers both sign-in and account creation. Replace the existing two-button `<div class="flex flex-wrap items-center justify-center gap-3 pt-1">` with:

```html
        <div class="flex flex-wrap items-center justify-center gap-3 pt-1">
          <a class="rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand/90" href="/login">
            Sign in
          </a>
          <a class="rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-medium transition-colors hover:border-brand/60" href="/login">
            Create an account
          </a>
          <a class="rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-medium transition-colors hover:border-brand/60" href="#quickstart">
            60-second quickstart
          </a>
        </div>
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run web/src/portal/landing-static.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add web/index.html web/src/portal/landing-static.test.ts
git commit -m "feat(portal): canonical URL, JSON-LD, and dual auth CTAs"
```

---

## Task 10: Member set-password banner

**Files:**
- Modify: `web/src/member/main.tsx`
- Test: `web/src/member/set-password.dom.test.tsx`

**Interfaces:**
- Consumes: `api.setPassword`, `api.member.overview` (now returns `has_password`), `PasswordInput` (Task 7).
- Produces: a dismissible banner shown when the signed-in account has no password, with an inline set-password form.

- [x] **Step 1: Write the failing DOM test**

Create `web/src/member/set-password.dom.test.tsx`. Because the member page is large, test the extracted banner component. First extract the banner into `web/src/member/set-password-banner.tsx` (Step 3); the test targets that component:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const setPassword = vi.fn(async () => ({ set: true }));
vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { setPassword: (...args: unknown[]) => setPassword(...args) }
}));

import { SetPasswordBanner } from './set-password-banner';

afterEach(cleanup);

describe('SetPasswordBanner', () => {
  it('submits a matching password and hides after success', async () => {
    const onDone = vi.fn();
    render(<SetPasswordBanner onDone={onDone} />);
    await userEvent.type(screen.getByLabelText(/^password$/i), 'a-very-strong-passphrase-1');
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'a-very-strong-passphrase-1');
    await userEvent.click(screen.getByRole('button', { name: /save password/i }));
    expect(setPassword).toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  it('blocks mismatched confirmation', async () => {
    render(<SetPasswordBanner onDone={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/^password$/i), 'a-very-strong-passphrase-1');
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'a-different-value-here-1');
    await userEvent.click(screen.getByRole('button', { name: /save password/i }));
    expect(setPassword).not.toHaveBeenCalled();
    expect(screen.getByText(/do not match/i)).toBeTruthy();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/src/member/set-password.dom.test.tsx`
Expected: FAIL — cannot resolve `./set-password-banner`.

- [x] **Step 3: Create the banner component**

Create `web/src/member/set-password-banner.tsx`:

```tsx
import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { Button } from '../components/ui';
import { PasswordInput } from '../components/password-input';

const MIN_PASSWORD = 12;

/**
 * Shown to members who signed in through the legacy passwordless path and have
 * not yet chosen a password. Setting one opts them into password + OTP login.
 */
export function SetPasswordBanner({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    if (password !== confirm) return setError('Passwords do not match.');
    if (password.length < MIN_PASSWORD) return setError(`Password must be at least ${MIN_PASSWORD} characters.`);
    setBusy(true);
    try {
      await api.setPassword({ password, confirmPassword: confirm });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-card border border-brand/40 bg-brand-soft p-4">
      <p className="text-sm font-medium text-ink">Add a password to your account</p>
      <p className="mt-1 text-xs text-muted">
        You signed in with a one-time email code. Set a password to use password + code sign-in next time.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <PasswordInput label="Password" value={password} onChange={setPassword} autoComplete="new-password" />
        <PasswordInput label="Confirm password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
      </div>
      {error && <p className="mt-2 text-xs text-bad">{error}</p>}
      <div className="mt-3 flex gap-2">
        <Button busy={busy} onClick={() => void save()}>Save password</Button>
        <Button variant="ghost" onClick={onDone}>Dismiss</Button>
      </div>
    </div>
  );
}
```

- [x] **Step 4: Wire the banner into the member page**

In `web/src/member/main.tsx`, import the banner and track the flag. Add to the state near `account`:

```tsx
  const [needsPassword, setNeedsPassword] = useState(false);
```

In the `load()` function where `overview` is consumed, set the flag from the response:

```tsx
      setNeedsPassword(overview.account.has_password === false);
```

(Extend the local `account` state type to include `has_password?: boolean` if it is typed inline.)

Render the banner at the top of the main content, inside the `Shell` children, before the tab content:

```tsx
      {needsPassword && <div className="mb-4"><SetPasswordBanner onDone={() => setNeedsPassword(false)} /></div>}
```

Add the import:

```tsx
import { SetPasswordBanner } from './set-password-banner';
```

- [x] **Step 5: Run test to verify it passes**

Run: `npx vitest run web/src/member/set-password.dom.test.tsx`
Expected: PASS.

- [x] **Step 6: Build the console**

Run: `npm --prefix web run build`
Expected: build succeeds.

- [x] **Step 7: Commit**

```bash
git add web/src/member/set-password-banner.tsx web/src/member/set-password.dom.test.tsx web/src/member/main.tsx
git commit -m "feat(member): set-password banner for legacy accounts"
```

---

## Task 11: Full validation, docs, and release readiness

**Files:**
- Modify: `README.md` (auth surface table + canonical status note)
- No code changes unless validation surfaces a defect.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a green `npm run validate` and `npm run ci:local`, updated README, and a commit ready for the operator release-authority procedure.

- [x] **Step 1: Run the full validation suite**

Run: `npm run validate`
Expected: PASS — conventions, secret scan, lint, typecheck, and both test projects green.

- [x] **Step 2: Run the local CI pipeline**

Run: `npm run ci:local`
Expected: PASS — validate + `build:all` + shell gates. This packages a release tarball from the current HEAD.

- [x] **Step 3: Update the README auth surface**

In `README.md`, in the "What ships in a release" table, update the `Login` row and add the new auth operations. Replace:

```
| Login | `GET /login` | none |
```

with:

```
| Login | `GET /login` | none |
| Register | `POST /console/api/auth/register` (+`/verify`) | allowed Origin |
| Password sign-in | `POST /console/api/auth/login/password` (+`/verify`) | allowed Origin |
| Password reset | `POST /console/api/auth/password/request-reset` (+`/reset`) | allowed Origin |
| Set password | `POST /console/api/auth/password/set` | session cookie |
```

Add a short note under the table:

```
Console passwords are stored as scrypt hashes; every password sign-in and
registration still requires a one-time email code. Legacy passwordless
accounts keep working through email OTP until they set a password.
```

- [x] **Step 4: Re-run validation after the README edit**

Run: `npm run validate`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document password + OTP console authentication"
```

- [x] **Step 6: Hand off to release authority**

Do NOT deploy from this session. Follow `docs/runbooks/operator-release-authority.md`: clean checkout at the merge SHA, both lockfiles, `npm run ci:local`, artifact with full Git SHA + checksum, then activation via `scripts/deploy.sh`. Update the Notion canonical status and checkpoint only after the gate evidence is recorded.

---

## Self-Review Notes

- **Spec coverage:** Registration (Task 3), password login (Task 4), reset + set (Task 5), legacy compatibility (Task 2 backfill + Task 5 set + Task 10 banner), migration (Task 2), hashing (Task 1), allowlist/OpenAPI/documented-ops lockstep (Tasks 3–5), eye toggle (Task 7), login shell (Task 8), portal SEO (Task 9), release gate (Task 11). Anti-enumeration is asserted in Tasks 3, 4, and 5 tests.
- **Type consistency:** `issueCode`/`consumeCode` signatures are identical across Tasks 2–5. `has_password` is added to both `/console/api/session` and `/console/api/member/overview` in Task 5 and consumed by the `SessionState` type (Task 6) and member banner (Task 10). `PasswordInput` props are identical in Tasks 7, 8, and 10.
- **Contract atomicity:** Task 3 adds the single allowlist alternation and ALL seven `DOCUMENTED_OPERATIONS` entries plus ALL seven OpenAPI paths up front, so Tasks 4 and 5 only add handlers and the contract test stays green at every commit.
- **No placeholders:** every code step contains real code. The member-page wiring in Task 10 references the actual `load()`/`Shell` structure observed in `web/src/member/main.tsx`.

---

## Execution record — 17 August 2026

All eleven tasks executed. Merge SHA `d0b334c3595545d16e27c2243854442ddfbdf9ce`
on `main`, pushed to `origin`.

| Gate | Result |
| --- | --- |
| `npm run validate` | PASS — 581 tests across 79 files (node + console-dom) |
| `npm run ci:local` | PASS — validate + `build:all` + shell gates |
| Release artifact | `.release/d0b334c3595545d16e27c2243854442ddfbdf9ce.tar.gz`, SHA-256 checksum verified |
| GitHub `quality` mirror | `success` on `d0b334c` (run 31981908475) |
| Production deploy | NOT PERFORMED from this session — see below |

Two defects surfaced during validation and were fixed rather than worked around:

1. `src/accounts/store.ts` — the `create()` row literal omitted the two columns
   migration `0016` adds, so `tsc --noEmit` rejected it (`de2c538`).
2. `tests/portal-copy.test.ts` — the copy-honesty guard read
   `web/src/login/main.tsx`, which Task 8 replaced with an auth shell. It was
   repointed at the static landing page `web/index.html`, which now owns the
   marketing copy (`9bd4444`). The same test was also outside every Vitest
   `include` pattern, so it had not been running; `web/vitest.config.ts` now
   collects `src/**/*.test.ts` alongside the DOM files.

Deployment remains with the release authority per
`docs/runbooks/operator-release-authority.md`: clean checkout at `d0b334c`, both
lockfiles, a second independent `npm run ci:local`, checksum comparison, then
activation via `scripts/deploy.sh`. Migration `0016_account_passwords` applies on
first start of the new release and has not yet touched production data.
