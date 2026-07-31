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
import { testConfig } from './support/harness.js';
import type { Config } from '../src/config.js';

/**
 * The admin surface is reached for real here rather than asserted at the store
 * level: `ConsoleDeps.access` is the injection seam `buildApp` does not expose,
 * and `AccessVerifier` accepts its own fetcher and resolver, so a locally signed
 * assertion can pass the same verification production runs.
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'kid-admin-contract';
const TEAM = 'leuwongrr.cloudflareaccess.com';
const AUD = 'a'.repeat(32);
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
    sub: 'access-subject-admin',
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
  billing: BillingService;
  account: { id: string; tenantId: string };
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

function start(overrides: Partial<Config> = {}): Surface {
  root = mkdtempSync(join(tmpdir(), 'lwrr-admin-'));
  const config: Config = {
    ...testConfig,
    CONSOLE_ENABLED: true,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ...overrides
  };
  const db = new GatewayDatabase(join(root, 'gateway.db'), config.API_KEY_PEPPER);
  const accounts = new AccountStore(db.db, config.API_KEY_PEPPER);
  const billing = new BillingService(db.db);
  const created = accounts.create({ email: ADMIN_EMAIL, role: 'admin' });
  const app = Fastify({ genReqId: () => 'trace-admin-contract' });
  const certs = (async () =>
    new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })) as unknown as typeof fetch;
  registerConsole(app, {
    config,
    db,
    accounts,
    billing,
    payments: new CryptomusClient(config),
    access: new AccessVerifier(TEAM, AUD, 60_000, certs, async () => ['104.16.0.1']),
    logger: createLogger('silent')
  });
  surface = { app, db, billing, account: { id: created.id, tenantId: created.tenantId } };
  return surface;
}

async function readAccounts(active: Surface) {
  const response = await active.app.inject({
    method: 'GET',
    url: '/console/api/admin/accounts',
    headers: { 'cf-access-jwt-assertion': assertion() }
  });
  expect(response.statusCode).toBe(200);
  return response.json().accounts as Array<{
    tenantId: string;
    billing: { plan: { dailyBudgetUnits: number; maxConcurrent: number; rateLimitRpm: number } | null };
    limits: { dailyBudgetUnits: number; maxConcurrent: number; rateLimitRpm: number; stored: boolean };
  }>;
}

describe('admin accounts response carries the enforced limits', () => {
  it('reports the process defaults, flagged as unstored, before any row exists', async () => {
    const active = start();
    const [entry] = await readAccounts(active);

    expect(active.db.tenants.limits(active.account.tenantId)).toBeNull();
    // The editor seeds from these values, so an absent row has to arrive as the
    // defaults the request path falls back to rather than as null or as zeroes.
    expect(entry?.limits).toEqual({
      dailyBudgetUnits: testConfig.DAILY_BUDGET_UNITS,
      maxConcurrent: testConfig.TENANT_MAX_CONCURRENT,
      rateLimitRpm: testConfig.RATE_LIMIT_RPM,
      stored: false
    });
  });

  /**
   * The finding this covers: the editor seeded itself from `billing.plan`, which
   * records only what `applyPlanLimits` copied in when the subscription started.
   * After a direct limit edit the plan no longer describes what is enforced, so
   * saving the form wrote the stale plan values back and reverted the edit.
   */
  it('reports the stored row rather than the subscribed plan after a limit edit', async () => {
    const active = start();
    active.billing.upsertPlan({
      id: 'starter',
      name: 'Starter',
      monthlyPriceCents: 0,
      includedTokens: 10,
      overageCentsPerMillion: 400,
      maxConcurrent: 3,
      rateLimitRpm: 55,
      dailyBudgetUnits: 999,
      models: ['lwrr-text']
    });
    active.billing.startSubscription(active.account.id, 'starter');

    const seeded = await readAccounts(active);
    expect(seeded[0]?.limits).toEqual({
      dailyBudgetUnits: 999,
      maxConcurrent: 3,
      rateLimitRpm: 55,
      stored: true
    });

    active.db.tenants.setLimits(active.account.tenantId, {
      dailyBudgetUnits: 42,
      maxConcurrent: 1,
      rateLimitRpm: 7
    });

    const [entry] = await readAccounts(active);
    expect(entry?.limits).toEqual({
      dailyBudgetUnits: 42,
      maxConcurrent: 1,
      rateLimitRpm: 7,
      stored: true
    });
    // The plan is deliberately left describing the superseded envelope: that
    // divergence is exactly what made seeding from it lose the edit.
    expect(entry?.billing.plan).toMatchObject({
      dailyBudgetUnits: 999,
      maxConcurrent: 3,
      rateLimitRpm: 55
    });
  });

  it('refuses a non-finite limit at the route instead of writing it', async () => {
    const active = start();
    for (const body of [
      { tenantId: active.account.tenantId, dailyBudgetUnits: 12.5, maxConcurrent: 1, rateLimitRpm: 7 },
      { tenantId: active.account.tenantId, dailyBudgetUnits: 10, maxConcurrent: null, rateLimitRpm: 7 },
      { tenantId: active.account.tenantId, dailyBudgetUnits: 10, maxConcurrent: 1, rateLimitRpm: 0 }
    ]) {
      const response = await active.app.inject({
        method: 'POST',
        url: '/console/api/admin/accounts/limits',
        headers: { 'cf-access-jwt-assertion': assertion() },
        payload: body
      });
      expect({ body, status: response.statusCode }).toEqual({ body, status: 400 });
      expect(response.json().error.code).toBe('invalid_request');
    }
    expect(active.db.tenants.limits(active.account.tenantId)).toBeNull();
  });

  it('writes a valid edit through and reports it as stored', async () => {
    const active = start();
    const written = await active.app.inject({
      method: 'POST',
      url: '/console/api/admin/accounts/limits',
      headers: { 'cf-access-jwt-assertion': assertion() },
      payload: {
        tenantId: active.account.tenantId,
        dailyBudgetUnits: 500,
        maxConcurrent: 2,
        rateLimitRpm: 30
      }
    });
    expect(written.statusCode).toBe(200);

    const [entry] = await readAccounts(active);
    expect(entry?.limits).toEqual({
      dailyBudgetUnits: 500,
      maxConcurrent: 2,
      rateLimitRpm: 30,
      stored: true
    });
  });
});
