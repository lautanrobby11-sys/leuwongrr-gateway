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
    writeFileSync(join(root, `${page}.html`), '<!doctype html>', 'utf8');
  }
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
      method: 'POST',
      url: '/console/api/auth/password/request-reset',
      headers: { origin: CONSOLE_ORIGIN },
      payload: { email: 'ghost@example.test' }
    });
    expect(unknown.statusCode).toBe(200);

    const requested = await active.app.inject({
      method: 'POST',
      url: '/console/api/auth/password/request-reset',
      headers: { origin: CONSOLE_ORIGIN },
      payload: { email: 'resetme@example.test' }
    });
    expect(requested.statusCode).toBe(200);
    const code = requested.json().dev_code as string;

    const done = await active.app.inject({
      method: 'POST',
      url: '/console/api/auth/password/reset',
      headers: { origin: CONSOLE_ORIGIN },
      payload: { email: 'resetme@example.test', code, password: STRONG, confirmPassword: STRONG }
    });
    expect(done.statusCode).toBe(200);
    const raw = active.db.db
      .prepare('SELECT password_hash FROM accounts WHERE id=?')
      .get(account.id) as { password_hash: string };
    expect(verifyPassword(STRONG, raw.password_hash)).toBe(true);
  });

  it('rejects a reset with a wrong code', async () => {
    const active = start();
    signIn(active, 'resetme2@example.test');
    await active.app.inject({
      method: 'POST',
      url: '/console/api/auth/password/request-reset',
      headers: { origin: CONSOLE_ORIGIN },
      payload: { email: 'resetme2@example.test' }
    });
    const bad = await active.app.inject({
      method: 'POST',
      url: '/console/api/auth/password/reset',
      headers: { origin: CONSOLE_ORIGIN },
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
      method: 'POST',
      url: '/console/api/auth/password/set',
      headers: { cookie, origin: CONSOLE_ORIGIN },
      payload: { password: STRONG, confirmPassword: STRONG }
    });
    expect(response.statusCode).toBe(200);
    const raw = active.db.db
      .prepare('SELECT password_hash FROM accounts WHERE id=?')
      .get(account.id) as { password_hash: string };
    expect(verifyPassword(STRONG, raw.password_hash)).toBe(true);
  });

  it('requires a session', async () => {
    const active = start();
    const response = await active.app.inject({
      method: 'POST',
      url: '/console/api/auth/password/set',
      headers: { origin: CONSOLE_ORIGIN },
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
    await active.app.inject({
      method: 'POST',
      url: '/console/api/auth/password/set',
      headers: { cookie, origin: CONSOLE_ORIGIN },
      payload: { password: STRONG, confirmPassword: STRONG }
    });
    const after = await active.app.inject({ method: 'GET', url: '/console/api/session', headers: { cookie } });
    expect(after.json().account.has_password).toBe(true);
  });
});
