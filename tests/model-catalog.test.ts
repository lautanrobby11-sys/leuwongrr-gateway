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
import type { ModelRecord } from '../src/models/catalog.js';

/**
 * Release 2a model catalogue: the admin CRUD is reached for real through
 * registerConsole with a locally signed Access assertion, the same seam
 * admin-limits-contract uses. The store layer (ModelCatalog) is exercised
 * through these routes; the request path still uses the static registry.
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'kid-model-catalog';
const TEAM = 'leuwongrr.cloudflareaccess.com';
const AUD = 'm'.repeat(32);
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
    sub: 'access-subject-model',
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
  root = mkdtempSync(join(tmpdir(), 'lwrr-model-catalog-'));
  const config: Config = {
    ...testConfig,
    CONSOLE_ENABLED: true,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD
  };
  const db = new GatewayDatabase(join(root, 'gateway.db'), config.API_KEY_PEPPER);
  const accounts = new AccountStore(db.db, config.API_KEY_PEPPER);
  accounts.create({ email: ADMIN_EMAIL, role: 'admin' });
  const app = Fastify({ genReqId: () => 'trace-model-catalog' });
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

function modelPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'lwrr-vision',
    name: 'Leuwongrr Vision',
    provider: 'openai',
    inputPriceCents: 250,
    outputPriceCents: 1000,
    cacheReadPriceCents: 50,
    multimodalSupport: true,
    upstreamModel: 'gpt-5-vision',
    enabled: true,
    ...overrides
  };
}

describe('model catalogue admin CRUD (Release 2a)', () => {
  it('registers, lists, amends, and removes a model', async () => {
    const active = start();
    const created = await active.app.inject({
      method: 'POST',
      url: '/console/api/admin/models',
      headers,
      payload: modelPayload()
    });
    expect(created.statusCode).toBe(200);
    const createdBody = created.json() as { model: ModelRecord };
    expect(createdBody.model).toMatchObject({
      id: 'lwrr-vision',
      name: 'Leuwongrr Vision',
      provider: 'openai',
      inputPriceCents: 250,
      outputPriceCents: 1000,
      cacheReadPriceCents: 50,
      multimodalSupport: true,
      upstreamModel: 'gpt-5-vision',
      enabled: true
    });
    expect(createdBody.model.createdAt).toBeTruthy();

    const listed = await active.app.inject({ method: 'GET', url: '/console/api/admin/models', headers });
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as { catalog: ModelRecord[]; policies: unknown[] };
    expect(body.catalog).toHaveLength(1);
    expect(body.policies).toEqual([]);

    const amended = await active.app.inject({
      method: 'PUT',
      url: '/console/api/admin/models/lwrr-vision',
      headers,
      payload: { inputPriceCents: 500, multimodalSupport: false }
    });
    expect(amended.statusCode).toBe(200);
    const amendedBody = amended.json() as { model: ModelRecord };
    expect(amendedBody.model.inputPriceCents).toBe(500);
    expect(amendedBody.model.multimodalSupport).toBe(false);
    // Unmentioned fields keep their values.
    expect(amendedBody.model.outputPriceCents).toBe(1000);
    expect(amendedBody.model.provider).toBe('openai');

    const removed = await active.app.inject({
      method: 'DELETE',
      url: '/console/api/admin/models/lwrr-vision',
      headers
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().deleted).toBe(true);

    const after = await active.app.inject({ method: 'GET', url: '/console/api/admin/models', headers });
    expect((after.json() as { catalog: ModelRecord[] }).catalog).toHaveLength(0);
  });

  it('rejects a duplicate model id with 409', async () => {
    const active = start();
    await active.app.inject({ method: 'POST', url: '/console/api/admin/models', headers, payload: modelPayload() });
    const dup = await active.app.inject({
      method: 'POST',
      url: '/console/api/admin/models',
      headers,
      payload: modelPayload()
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('model_already_exists');
  });

  it('refuses to delete a model an active plan entitles', async () => {
    const active = start();
    await active.app.inject({ method: 'POST', url: '/console/api/admin/models', headers, payload: modelPayload() });
    active.db.db
      .prepare(
        `INSERT INTO plans (id, name, monthly_price_cents, included_tokens, overage_cents_per_million, max_concurrent, rate_limit_rpm, daily_budget_units, models_json, active, updated_at)
         VALUES ('plan-a', 'Plan A', 0, 0, 100, 1, 10, 100, ?, 1, datetime('now'))`
      )
      .run(JSON.stringify(['lwrr-vision']));

    const removed = await active.app.inject({
      method: 'DELETE',
      url: '/console/api/admin/models/lwrr-vision',
      headers
    });
    expect(removed.statusCode).toBe(409);
    expect(removed.json().error.code).toBe('model_in_use_by_plan');
  });

  it('returns 404 when amending or removing an unknown model', async () => {
    const active = start();
    const amended = await active.app.inject({
      method: 'PUT',
      url: '/console/api/admin/models/nope',
      headers,
      payload: { name: 'x' }
    });
    expect(amended.statusCode).toBe(404);
    const removed = await active.app.inject({ method: 'DELETE', url: '/console/api/admin/models/nope', headers });
    expect(removed.statusCode).toBe(404);
  });

  it('rejects invalid payloads with 400', async () => {
    const active = start();
    for (const payload of [
      modelPayload({ id: 'UPPER' }), // id must be lower-case
      modelPayload({ provider: 'vendor-x' }), // provider must be in the enum
      modelPayload({ inputPriceCents: -5 }), // price must not be negative
      modelPayload({ inputPriceCents: 12.5 }), // price must be integral
      { id: 'lwrr-vision' } // missing required fields
    ]) {
      const response = await active.app.inject({
        method: 'POST',
        url: '/console/api/admin/models',
        headers,
        payload
      });
      expect({ id: (payload as { id?: string }).id, status: response.statusCode }).toEqual({
        id: (payload as { id?: string }).id,
        status: 400
      });
    }
  });

  it('requires a valid admin assertion', async () => {
    const active = start();
    for (const options of [
      { method: 'GET', url: '/console/api/admin/models' },
      { method: 'POST', url: '/console/api/admin/models', payload: modelPayload() },
      { method: 'POST', url: '/console/api/admin/models/policy', payload: {} }
    ] as const) {
      const response = await active.app.inject({ ...options });
      expect(response.statusCode).toBe(401);
    }
  });

  it('keeps the entitlement toggle on its dedicated path', async () => {
    const active = start();
    const tenantId = (active.db.db
      .prepare('SELECT id FROM tenants LIMIT 1')
      .get() as { id: string }).id;
    const toggled = await active.app.inject({
      method: 'POST',
      url: '/console/api/admin/models/policy',
      headers,
      payload: { tenantId, modelId: 'lwrr-text', enabled: false }
    });
    expect(toggled.statusCode).toBe(200);
    expect(toggled.json().updated).toBe(true);
    const row = active.db.db
      .prepare('SELECT enabled FROM model_policies WHERE tenant_id = ? AND model_id = ?')
      .get(tenantId, 'lwrr-text') as { enabled: number } | undefined;
    expect(row?.enabled).toBe(0);
  });

  it('removes a model together with its entitlement rows', async () => {
    const active = start();
    await active.app.inject({ method: 'POST', url: '/console/api/admin/models', headers, payload: modelPayload() });
    const tenantId = (active.db.db
      .prepare('SELECT id FROM tenants LIMIT 1')
      .get() as { id: string }).id;
    active.db.tenants.setModelPolicy(tenantId, 'lwrr-vision', true);

    const removed = await active.app.inject({
      method: 'DELETE',
      url: '/console/api/admin/models/lwrr-vision',
      headers
    });
    expect(removed.statusCode).toBe(200);

    const policies = active.db.db
      .prepare('SELECT COUNT(*) AS n FROM model_policies WHERE model_id = ?')
      .get('lwrr-vision') as { n: number };
    expect(policies.n).toBe(0);
  });
});
