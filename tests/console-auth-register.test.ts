import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, jsonResponse, testConfig, type Harness } from './support/harness.js';

const CONSOLE_ORIGIN = 'http://127.0.0.1:2080';
let harness: Harness | null = null;
let distRoot: string | null = null;

afterEach(async () => {
  if (harness) {
    await harness.cleanup();
    harness = null;
  }
  if (distRoot) {
    rmSync(distRoot, { recursive: true, force: true });
    distRoot = null;
  }
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
  harness = createHarness(jsonResponse, {
    CONSOLE_ENABLED: true,
    WEB_DIST_PATH: buildDist(),
    ...overrides
  });
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
    const account = active.db.db
      .prepare("SELECT email_verified_at FROM accounts WHERE email='new@example.test'")
      .get() as { email_verified_at: string | null };
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

    const after = active.db.db
      .prepare("SELECT email_verified_at, password_hash FROM accounts WHERE email='new@example.test'")
      .get() as { email_verified_at: string | null; password_hash: string | null };
    expect(after.email_verified_at).not.toBeNull();
    expect(after.password_hash).not.toBeNull();
  });

  it('rejects mismatched confirmation and weak passwords', async () => {
    const active = start();
    const mismatch = await active.app.inject({
      method: 'POST',
      url: '/console/api/auth/register',
      headers: { origin: CONSOLE_ORIGIN },
      payload: { name: 'A', email: 'x@example.test', password: STRONG, confirmPassword: 'different-value-here-1' }
    });
    expect(mismatch.statusCode).toBe(400);

    const weak = await active.app.inject({
      method: 'POST',
      url: '/console/api/auth/register',
      headers: { origin: CONSOLE_ORIGIN },
      payload: { name: 'A', email: 'y@example.test', password: 'short', confirmPassword: 'short' }
    });
    expect(weak.statusCode).toBe(400);
  });

  it('does not reveal that an email is already registered', async () => {
    const active = start();
    const body = { name: 'Dup', email: 'dup@example.test', password: STRONG, confirmPassword: STRONG };
    const first = await active.app.inject({
      method: 'POST',
      url: '/console/api/auth/register',
      headers: { origin: CONSOLE_ORIGIN },
      payload: body
    });
    expect(first.statusCode).toBe(200);
    const code = first.json().dev_code as string;
    await active.app.inject({
      method: 'POST',
      url: '/console/api/auth/register/verify',
      headers: { origin: CONSOLE_ORIGIN },
      payload: { email: body.email, code }
    });

    // Re-registering an active account answers the same success shape, no second row.
    const second = await active.app.inject({
      method: 'POST',
      url: '/console/api/auth/register',
      headers: { origin: CONSOLE_ORIGIN },
      payload: body
    });
    expect(second.statusCode).toBe(200);
    const count = active.db.db
      .prepare("SELECT COUNT(*) AS c FROM accounts WHERE email='dup@example.test'")
      .get() as { c: number };
    expect(count.c).toBe(1);
  });
});
