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
      method: 'POST',
      url: '/console/api/auth/login/password',
      headers: { origin: CONSOLE_ORIGIN },
      payload: { email: 'pwuser@example.test', password: 'a-very-strong-passphrase-1' }
    });
    expect(step1.statusCode).toBe(200);
    const code = step1.json().dev_code as string;
    expect(code).toMatch(/^[0-9]{6}$/);
    expect(step1.headers['set-cookie']).toBeUndefined();

    const step2 = await active.app.inject({
      method: 'POST',
      url: '/console/api/auth/login/verify',
      headers: { origin: CONSOLE_ORIGIN },
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
      method: 'POST',
      url: '/console/api/auth/login/password',
      headers: { origin: CONSOLE_ORIGIN },
      payload: { email: 'pwuser@example.test', password: 'the-wrong-passphrase-999' }
    });
    const unknown = await active.app.inject({
      method: 'POST',
      url: '/console/api/auth/login/password',
      headers: { origin: CONSOLE_ORIGIN },
      payload: { email: 'ghost@example.test', password: 'a-very-strong-passphrase-1' }
    });
    const passwordless = await active.app.inject({
      method: 'POST',
      url: '/console/api/auth/login/password',
      headers: { origin: CONSOLE_ORIGIN },
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
      method: 'POST',
      url: '/console/api/auth/login/verify',
      headers: { origin: CONSOLE_ORIGIN },
      payload: { email: 'pwuser@example.test', code: '000000' }
    });
    expect(response.statusCode).toBe(401);
  });
});
