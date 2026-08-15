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
 * Regression guards for the console plan/model editors:
 *
 * 1. A plan read from GET /admin/plans echoes `modelGroupId` (and the Release 2
 *    purchase fields) back on save. The strict plan schema used to reject that
 *    key with 400 invalid_request, so no plan could be edited at all.
 * 2. A model created through the admin surface lands in `legacy-default` (or
 *    the group the editor chose) instead of group NULL, which made every new
 *    model unresolvable (`model_group_missing`).
 */
import { createSign, generateKeyPairSync } from 'node:crypto';
const KID = 'kid-plan-edit';
const TEAM = 'leuwongrr.cloudflareaccess.com';
const AUD = 'p'.repeat(32);
const ADMIN_EMAIL = 'owner@leuwongrr.cloud';
const { publicKey: pk, privateKey: sk } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...(pk.export({ format: 'jwk' }) as unknown as Record<string, unknown>),
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
    sub: 'access-subject-plan',
    aud: [AUD],
    iss: 'https://' + TEAM,
    exp: Math.floor(Date.now() / 1000) + 300
  });
  const signer = createSign('RSA-SHA256');
  signer.update(header + '.' + payload);
  signer.end();
  return header + '.' + payload + '.' + signer.sign(sk).toString('base64url');
}

interface Surface { app: FastifyInstance; db: GatewayDatabase }

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
  root = mkdtempSync(join(tmpdir(), 'lwrr-plan-edit-'));
  const config: Config = {
    ...testConfig,
    CONSOLE_ENABLED: true,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD
  };
  const db = new GatewayDatabase(join(root, 'gateway.db'), config.API_KEY_PEPPER);
  const accounts = new AccountStore(db.db, config.API_KEY_PEPPER);
  accounts.create({ email: ADMIN_EMAIL, role: 'admin' });
  const app = Fastify({ genReqId: () => 'trace-plan-edit' });
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
  surface = { app, db };
  return surface;
}

const headers = { 'cf-access-jwt-assertion': assertion() };

describe('console plan & model editor regression (Release 2a fixes)', () => {
  it('accepts the echoed plan round-trip including modelGroupId', async () => {
    const active = start();
    // Seed a group the plan can reference.
    active.db.db
      .prepare('INSERT INTO model_groups (id, name, multiplier_bps, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, datetime(\'now\'), datetime(\'now\'))')
      .run('grp-a', 'Group A', 10000);

    const created = await active.app.inject({
      method: 'POST',
      url: '/console/api/admin/plans',
      headers,
      payload: {
        id: 'plan-x',
        name: 'Plan X',
        monthlyPriceCents: 2900,
        includedTokens: 10000000,
        overageCentsPerMillion: 200,
        maxConcurrent: 4,
        rateLimitRpm: 120,
        dailyBudgetUnits: 1000000,
        models: [],
        active: true,
        modelGroupId: 'grp-a'
      }
    });
    expect(created.statusCode).toBe(200);

    const listed = await active.app.inject({
      method: 'GET',
      url: '/console/api/admin/plans',
      headers
    });
    expect(listed.statusCode).toBe(200);
    const plan = (listed.json() as { plans: Array<Record<string, unknown>> }).plans.find((item) => item.id === 'plan-x');
    expect(plan).toBeTruthy();
    expect(plan?.modelGroupId).toBe('grp-a');

    // The exact object the browser would submit after editing a field.
    const echo = await active.app.inject({
      method: 'POST',
      url: '/console/api/admin/plans',
      headers,
      payload: { ...plan, monthlyPriceCents: 3500 }
    });
    expect(echo.statusCode).toBe(200);
    const saved = echo.json() as { plan: Record<string, unknown> };
    expect(saved.plan.monthlyPriceCents).toBe(3500);
    expect(saved.plan.modelGroupId).toBe('grp-a');
  });

  it('preserves the model group when a legacy payload omits modelGroupId', async () => {
    const active = start();
    active.db.db
      .prepare('INSERT INTO model_groups (id, name, multiplier_bps, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, datetime(\'now\'), datetime(\'now\'))')
      .run('grp-b', 'Group B', 10000);
    const created = await active.app.inject({
      method: 'POST',
      url: '/console/api/admin/plans',
      headers,
      payload: { id: 'plan-y', name: 'Plan Y', monthlyPriceCents: 100, includedTokens: 1000, overageCentsPerMillion: 10, maxConcurrent: 2, rateLimitRpm: 60, dailyBudgetUnits: 50000, models: [], active: true, modelGroupId: 'grp-b' }
    });
    expect(created.statusCode).toBe(200);

    // Legacy writer: no modelGroupId anywhere in the payload.
    const legacy = await active.app.inject({
      method: 'POST',
      url: '/console/api/admin/plans',
      headers,
      payload: { id: 'plan-y', name: 'Plan Y', monthlyPriceCents: 200, includedTokens: 2000, overageCentsPerMillion: 10, maxConcurrent: 2, rateLimitRpm: 60, dailyBudgetUnits: 50000, models: [], active: true }
    });
    expect(legacy.statusCode).toBe(200);
    const saved = legacy.json() as { plan: Record<string, unknown> };
    expect(saved.plan.modelGroupId).toBe('grp-b');
  });

  it('places a newly created model into the legacy-default group', async () => {
    const active = start();
    const created = await active.app.inject({
      method: 'POST',
      url: '/console/api/admin/models',
      headers,
      payload: {
        id: 'lwrr-new',
        name: 'New Model',
        provider: 'other',
        inputPriceCents: 0,
        outputPriceCents: 0,
        cacheReadPriceCents: 0,
        multimodalSupport: false,
        upstreamModel: 'auto',
        enabled: true
      }
    });
    expect(created.statusCode).toBe(200);
    const model = created.json() as { model: Record<string, unknown> };
    expect(model.model.groupId).toBe('legacy-default');

    const row = active.db.db
      .prepare('SELECT group_id FROM models WHERE public_id = ?')
      .get('lwrr-new') as { group_id: string | null };
    expect(row.group_id).toBe('legacy-default');
  });

  it('parses a plan group auto-derived model list from the group members', async () => {
    const active = start();
    active.db.db
      .prepare('INSERT INTO model_groups (id, name, multiplier_bps, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, datetime(\'now\'), datetime(\'now\'))')
      .run('grp-c', 'Group C', 10000);
    // One model already exists in the group via a full-row insert.
    active.db.db
      .prepare(
        "INSERT INTO models (id, public_id, display_name, provider, multimodal, input_price_per_m, output_price_per_m, cache_read_price_per_m, cache_write_price_per_m, enabled, input_price_cents, output_price_cents, cache_read_price_cents, upstream_model, group_id, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 1, 0, 0, 0, 'auto', 'grp-c', datetime('now'), datetime('now'))"
      )
      .run('u1', 'lwrr-group-c', 'Group C Model', 'other');

    const created = await active.app.inject({
      method: 'POST',
      url: '/console/api/admin/plans',
      headers,
      payload: { id: 'plan-z', name: 'Plan Z', monthlyPriceCents: 100, includedTokens: 1000, overageCentsPerMillion: 10, maxConcurrent: 2, rateLimitRpm: 60, dailyBudgetUnits: 50000, models: [], active: true, modelGroupId: 'grp-c' }
    });
    expect(created.statusCode).toBe(200);
    const plan = (created.json() as { plan: Record<string, unknown> }).plan;
    expect((plan.models as string[])).toContain('lwrr-group-c');
  });
});