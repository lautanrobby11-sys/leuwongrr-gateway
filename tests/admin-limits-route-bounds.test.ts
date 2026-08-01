import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts/store.js';
import { AccessVerifier } from '../src/accounts/access.js';
import { BillingService } from '../src/billing/service.js';
import { CryptomusClient } from '../src/payments/cryptomus.js';
import { GatewayDatabase } from '../src/persistence/database.js';
import { registerConsole } from '../src/http/console.js';
import { createLogger } from '../src/observability.js';
import {
  DAILY_BUDGET_UNITS,
  MAX_CONCURRENT,
  RATE_LIMIT_RPM,
  limitsSaveDisabled
} from '../web/src/admin/limits-validation.js';
import { testConfig } from './support/harness.js';
import type { Config } from '../src/config.js';

/**
 * `tests/admin-limits-save-disabled.test.ts` proves the browser predicate agrees
 * with `planInputSchema`, and `tests/admin-limits-form-wiring.test.ts` proves the
 * modal routes its input through `parseLimitInput`. Neither reaches the endpoint
 * the form actually posts to, so a bound could drift in
 * `/console/api/admin/accounts/limits` alone and both suites would stay green.
 *
 * This file drives that route over the wire at every boundary value and asserts
 * two things at once: the route accepts exactly what it should, and it accepts
 * exactly what the browser predicate would have let the operator submit. The
 * second assertion is what makes a literal reappearing in `console.ts` a test
 * failure rather than a silent divergence.
 *
 * The verification seam is the same one `tests/admin-limits-contract.test.ts`
 * uses: `ConsoleDeps.access` is not exposed by `buildApp`, and `AccessVerifier`
 * takes its own fetcher, so a locally signed assertion clears the real check.
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'kid-limits-bounds';
const TEAM = 'leuwongrr.cloudflareaccess.com';
const AUD = 'b'.repeat(32);
const ADMIN_EMAIL = 'owner@leuwongrr.cloud';

const jwk = {
  ...(publicKey.export({ format: 'jwk' }) as unknown as Record<string, unknown>),
  kid: KID,
  alg: 'RS256',
  use: 'sig'
};

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function assertion(): string {
  const header = encode({ alg: 'RS256', typ: 'JWT', kid: KID });
  const payload = encode({
    email: ADMIN_EMAIL,
    sub: 'access-subject-limits-bounds',
    aud: [AUD],
    iss: 'https://' + TEAM,
    exp: Math.floor(Date.now() / 1000) + 300
  });
  const signer = createSign('RSA-SHA256');
  signer.update(header + '.' + payload);
  signer.end();
  return header + '.' + payload + '.' + signer.sign(privateKey).toString('base64url');
}

interface Surface {
  app: FastifyInstance;
  db: GatewayDatabase;
  tenantId: string;
}

let root: string | null = null;
let surface: Surface | null = null;

afterEach(async () => {
  if (surface) {
    await surface.app.close();
    surface.db.close();
    surface = null;
  }
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
});

function start(): Surface {
  root = mkdtempSync(join(tmpdir(), 'lwrr-limits-bounds-'));
  const config: Config = {
    ...testConfig,
    CONSOLE_ENABLED: true,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD
  };
  const db = new GatewayDatabase(join(root, 'gateway.db'), config.API_KEY_PEPPER);
  const accounts = new AccountStore(db.db, config.API_KEY_PEPPER);
  const created = accounts.create({ email: ADMIN_EMAIL, role: 'admin' });
  const app = Fastify({ genReqId: () => 'trace-limits-bounds' });
  const certs = (async () =>
    new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })) as unknown as typeof fetch;
  registerConsole(app, {
    config,
    db,
    accounts,
    billing: new BillingService(db.db),
    payments: new CryptomusClient(config),
    access: new AccessVerifier(TEAM, AUD, 60_000, certs, async () => ['104.16.0.1']),
    logger: createLogger('silent')
  });
  surface = { app, db, tenantId: created.tenantId };
  return surface;
}

const valid = { dailyBudgetUnits: 100_000, maxConcurrent: 2, rateLimitRpm: 120 };

const bounds = [
  { field: 'dailyBudgetUnits', bound: DAILY_BUDGET_UNITS },
  { field: 'maxConcurrent', bound: MAX_CONCURRENT },
  { field: 'rateLimitRpm', bound: RATE_LIMIT_RPM }
] as const;

async function post(active: Surface, limits: Record<string, unknown>) {
  return active.app.inject({
    method: 'POST',
    url: '/console/api/admin/accounts/limits',
    headers: { 'cf-access-jwt-assertion': assertion() },
    payload: { tenantId: active.tenantId, ...limits }
  });
}

describe('admin limits route enforces the shared bounds', () => {
  it.each(bounds)('accepts exactly the minimum for $field and stores it', async ({ field, bound }) => {
    const active = start();
    const response = await post(active, { ...valid, [field]: bound.min });

    expect({ field, status: response.statusCode }).toEqual({ field, status: 200 });
    expect(active.db.tenants.limits(active.tenantId)?.[field]).toBe(bound.min);
  });

  it.each(bounds)('accepts exactly the maximum for $field and stores it', async ({ field, bound }) => {
    const active = start();
    const response = await post(active, { ...valid, [field]: bound.max });

    expect({ field, status: response.statusCode }).toEqual({ field, status: 200 });
    expect(active.db.tenants.limits(active.tenantId)?.[field]).toBe(bound.max);
  });

  it.each(bounds)('rejects one below the minimum for $field and writes nothing', async ({ field, bound }) => {
    const active = start();
    const response = await post(active, { ...valid, [field]: bound.min - 1 });

    expect({ field, status: response.statusCode }).toEqual({ field, status: 400 });
    expect(response.json().error.code).toBe('invalid_request');
    expect(active.db.tenants.limits(active.tenantId)).toBeNull();
  });

  it.each(bounds)('rejects one above the maximum for $field and writes nothing', async ({ field, bound }) => {
    const active = start();
    const response = await post(active, { ...valid, [field]: bound.max + 1 });

    expect({ field, status: response.statusCode }).toEqual({ field, status: 400 });
    expect(response.json().error.code).toBe('invalid_request');
    expect(active.db.tenants.limits(active.tenantId)).toBeNull();
  });
});

/**
 * The divergence that mattered was never a wrong constant in isolation; it was
 * the form permitting a submission the route then refused with a 400 while Save
 * still looked usable. So the predicate and the route are compared directly, at
 * the four values where they could disagree, rather than each being compared to
 * a literal.
 */
describe('the browser predicate agrees with the route it posts to', () => {
  it.each(bounds)('$field: Save is enabled exactly when the route accepts', async ({ field, bound }) => {
    for (const value of [bound.min - 1, bound.min, bound.max, bound.max + 1]) {
      const active = start();
      const response = await post(active, { ...valid, [field]: value });
      const accepted = response.statusCode === 200;

      expect({ field, value, disabled: limitsSaveDisabled({ ...valid, [field]: value }) }).toEqual({
        field,
        value,
        disabled: !accepted
      });

      await active.app.close();
      active.db.close();
      surface = null;
      rmSync(root as string, { recursive: true, force: true });
      root = null;
    }
  });

  it('refuses a cleared field arriving as null rather than coercing it to zero', async () => {
    const active = start();
    const response = await post(active, { ...valid, dailyBudgetUnits: null });

    expect(response.statusCode).toBe(400);
    expect(active.db.tenants.limits(active.tenantId)).toBeNull();
  });
});
