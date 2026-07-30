import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts/store.js';
import { BillingService } from '../src/billing/service.js';
import { createHarness, jsonResponse, testConfig, type Harness } from './support/harness.js';

const CONSOLE_ORIGIN = 'http://127.0.0.1:2080';
const ACCESS_TEAM = 'leuwongrr.cloudflareaccess.com';
const ACCESS_AUD = 'a'.repeat(32);

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

/** A real bundle on disk: the page handler reads files, so it needs files. */
function buildDist(withFiles = true): string {
  const root = mkdtempSync(join(tmpdir(), 'lwrr-dist-'));
  distRoot = root;
  if (withFiles) {
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'login.html'), '<!doctype html><title>portal</title>', 'utf8');
    writeFileSync(join(root, 'member.html'), '<!doctype html><title>member</title>', 'utf8');
    writeFileSync(join(root, 'assets', 'member.js'), 'export const ok = 1;\n', 'utf8');
  }
  return root;
}

function start(overrides: Record<string, unknown> = {}, withFiles = true): Harness {
  harness = createHarness(jsonResponse, {
    CONSOLE_ENABLED: true,
    WEB_DIST_PATH: buildDist(withFiles),
    ...overrides
  });
  return harness;
}

/** Signs a member in through the canonical store, as the OTP flow would. */
function signIn(active: Harness, email = 'member@example.com') {
  const accounts = new AccountStore(active.db.db, testConfig.API_KEY_PEPPER);
  const account = accounts.create({ email });
  const token = accounts.createSession(account.id, testConfig.SESSION_TTL_HOURS);
  return { account, cookie: `${testConfig.SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` };
}

describe('console shell delivery', () => {
  it('serves the portal at the apex and at /login', async () => {
    const active = start();
    for (const url of ['/', '/login']) {
      const response = await active.app.inject({ method: 'GET', url });
      expect({ url, status: response.statusCode }).toEqual({ url, status: 200 });
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.headers['x-frame-options']).toBe('DENY');
    }
  });

  it('keeps the apex serving the portal when a query string is attached', async () => {
    const active = start();
    const response = await active.app.inject({ method: 'GET', url: '/?ref=email' });
    expect(response.statusCode).toBe(200);
  });

  it('answers 503 rather than 404 when the bundle was never built', async () => {
    const active = start({}, false);
    const response = await active.app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('console_not_built');
  });

  it('serves a hashed asset as immutable and cacheable', async () => {
    const active = start();
    const response = await active.app.inject({ method: 'GET', url: '/console/assets/member.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/javascript');
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('refuses a traversal attempt at the allowlist, before the handler', async () => {
    const active = start();
    const response = await active.app.inject({
      method: 'GET',
      url: '/console/assets/..%2f..%2fetc%2fpasswd'
    });
    expect(response.statusCode).toBe(404);
  });

  it('does not let an asset miss be cached as a negative answer', async () => {
    const active = start();
    const response = await active.app.inject({ method: 'GET', url: '/console/assets/missing.js' });
    expect(response.statusCode).toBe(404);
    // The shared hook drops cache-control for asset routes so a hit can declare
    // itself immutable. A miss must put it back, or an intermediary may cache the
    // 404 for a hashed name that exists in the next release.
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().error.code).toBe('route_not_found');
  });

  it('answers the gateway envelope on every console path when the console is off', async () => {
    const active = start({ CONSOLE_ENABLED: false });
    const paths = [
      '/',
      '/login',
      '/admin',
      '/member',
      '/chat',
      '/console/assets/member.js',
      '/console/api/session',
      '/console/api/admin/overview'
    ];
    for (const url of paths) {
      const response = await active.app.inject({ method: 'GET', url });
      // Allowlisted but unregistered: without the hook branch these fell through
      // to Fastify's default handler and answered {"message":"Route GET:/ not
      // found"}, which is not the documented error shape.
      expect({ url, status: response.statusCode }).toEqual({ url, status: 404 });
      expect({ url, code: response.json().error?.code }).toEqual({ url, code: 'route_not_found' });
      expect(response.headers['x-request-id']).toBeTruthy();
    }
  });

  it('carries the hardening headers on an unlisted path too', async () => {
    const active = start();
    const response = await active.app.inject({ method: 'GET', url: '/not-a-route' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('route_not_found');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('same-origin');
  });

  it('does not spend the data plane budget on shell traffic', async () => {
    const active = start();
    const attempts = testConfig.RATE_LIMIT_BURST * 2 + 5;
    for (let index = 0; index < attempts; index += 1) {
      await active.app.inject({ method: 'GET', url: '/console/assets/member.js' });
    }
    const models = await active.app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${active.token}` }
    });
    expect(models.statusCode).toBe(200);
  });
});

describe('console member surface', () => {
  const READS = ['overview', 'usage', 'plans', 'keys'] as const;

  it('requires a session on every member read', async () => {
    const active = start();
    for (const path of READS) {
      const response = await active.app.inject({
        method: 'GET',
        url: `/console/api/member/${path}`
      });
      expect({ path, status: response.statusCode }).toEqual({ path, status: 401 });
      expect(response.json().error.code).toBe('session_required');
    }
  });

  it('answers every member read for a signed in account', async () => {
    const active = start();
    const { cookie } = signIn(active);
    for (const path of READS) {
      const response = await active.app.inject({
        method: 'GET',
        url: `/console/api/member/${path}`,
        headers: { cookie }
      });
      expect({ path, status: response.statusCode }).toEqual({ path, status: 200 });
    }
  });

  it('lists a seeded plan, so subscribe and top-up are reachable', async () => {
    const active = start();
    const { cookie } = signIn(active);

    const before = await active.app.inject({
      method: 'GET',
      url: '/console/api/member/plans',
      headers: { cookie }
    });
    expect(before.json().plans).toEqual([]);

    new BillingService(active.db.db).upsertPlan({
      id: 'starter',
      name: 'Starter',
      monthlyPriceCents: 0,
      includedTokens: 0,
      overageCentsPerMillion: 400,
      maxConcurrent: 1,
      rateLimitRpm: 10,
      dailyBudgetUnits: 1000,
      models: ['lwrr-text']
    });

    const after = await active.app.inject({
      method: 'GET',
      url: '/console/api/member/plans',
      headers: { cookie }
    });
    expect(after.json().plans.map((plan: { id: string }) => plan.id)).toEqual(['starter']);
  });

  it('issues a key once and never returns it again', async () => {
    const active = start();
    const { cookie } = signIn(active);
    const issued = await active.app.inject({
      method: 'POST',
      url: '/console/api/member/keys',
      headers: { cookie, origin: CONSOLE_ORIGIN },
      payload: { name: 'laptop', scopes: ['models:read', 'chat:write'] }
    });
    expect(issued.statusCode).toBe(200);
    const plaintext = issued.json().key as string;
    expect(plaintext.length).toBeGreaterThan(20);

    const listed = await active.app.inject({
      method: 'GET',
      url: '/console/api/member/keys',
      headers: { cookie }
    });
    expect(listed.body).not.toContain(plaintext);
  });
});

describe('console admin surface', () => {
  /**
   * AccessVerifier is constructed inside buildApp with no injection seam, so a
   * successful assertion is out of reach here. The role predicate behind it is
   * covered at the store level in billing-settlement.test.ts.
   */
  it('reports that Access is not configured rather than trusting a cookie', async () => {
    const active = start();
    const { cookie } = signIn(active);
    const response = await active.app.inject({
      method: 'GET',
      url: '/console/api/admin/overview',
      headers: { cookie }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('access_not_configured');
  });

  it('demands an edge assertion once Access is configured', async () => {
    const active = start({ ACCESS_TEAM_DOMAIN: ACCESS_TEAM, ACCESS_AUD });
    const { cookie } = signIn(active);
    const response = await active.app.inject({
      method: 'GET',
      url: '/console/api/admin/overview',
      headers: { cookie }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('access_assertion_missing');
  });
});
