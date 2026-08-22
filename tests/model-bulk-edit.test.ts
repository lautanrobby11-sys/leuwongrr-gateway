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
 * Bulk model edit (`POST /console/api/admin/models/bulk`). The transaction is
 * the point of the route: a batch that names one bad group must land nothing,
 * and unknown ids come back as `missing` without failing the good rows.
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'kid-bulk';
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
    sub: 'access-subject-bulk',
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

function insertModel(db: GatewayDatabase, id: string, group = 'legacy-default'): void {
  db.db
    .prepare(
      "INSERT INTO models (id, public_id, display_name, provider, multimodal, input_price_per_m, output_price_per_m, cache_read_price_per_m, cache_write_price_per_m, enabled, input_price_cents, output_price_cents, cache_read_price_cents, upstream_model, group_id, created_at, updated_at) VALUES (?, ?, ?, 'other', 0, 0, 0, 0, 0, 0, 10, 20, 5, 'auto', ?, datetime('now'), datetime('now'))"
    )
    .run(`${id}-uuid`, id, id, group);
}

function start(): Surface {
  root = mkdtempSync(join(tmpdir(), 'lwrr-bulk-'));
  const config: Config = {
    ...testConfig,
    CONSOLE_ENABLED: true,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD
  };
  const db = new GatewayDatabase(join(root, 'gateway.db'), config.API_KEY_PEPPER);
  const accounts = new AccountStore(db.db, config.API_KEY_PEPPER);
  accounts.create({ email: ADMIN_EMAIL, role: 'admin' });
  const app = Fastify({ genReqId: () => 'trace-bulk' });
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

describe('admin bulk model edit', () => {
  it('applies partial updates and reports unknown ids as missing', async () => {
    const active = start();
    insertModel(active.db, 'gpt-5');
    insertModel(active.db, 'claude-opus');
    const response = await active.app.inject({
      method: 'POST',
      url: '/console/api/admin/models/bulk',
      headers,
      payload: {
        rows: [
          { id: 'gpt-5', inputPriceCents: 125, enabled: true },
          { id: 'claude-opus', outputPriceCents: 7500 },
          { id: 'ghost-model', inputPriceCents: 1 }
        ]
      }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { updated: string[]; missing: string[] };
    expect(body.updated.sort()).toEqual(['claude-opus', 'gpt-5']);
    expect(body.missing).toEqual(['ghost-model']);

    const listed = await active.app.inject({ method: 'GET', url: '/console/api/admin/models', headers });
    const catalog = (listed.json() as { catalog: Array<Record<string, unknown>> }).catalog;
    const gpt = catalog.find((model) => model.id === 'gpt-5');
    expect(gpt?.inputPriceCents).toBe(125);
    expect(gpt?.enabled).toBe(true);
    // A field left out of the row is untouched.
    expect(gpt?.outputPriceCents).toBe(20);
  });

  it('rolls the whole batch back when a row names an unknown group', async () => {
    const active = start();
    insertModel(active.db, 'gpt-5');
    const response = await active.app.inject({
      method: 'POST',
      url: '/console/api/admin/models/bulk',
      headers,
      payload: {
        rows: [
          { id: 'gpt-5', inputPriceCents: 999 },
          { id: 'gpt-5', groupId: 'no-such-group' }
        ]
      }
    });
    expect(response.statusCode).toBe(400);
    // The first row's price change must not survive the failed transaction.
    const listed = await active.app.inject({ method: 'GET', url: '/console/api/admin/models', headers });
    const gpt = (listed.json() as { catalog: Array<Record<string, unknown>> }).catalog.find(
      (model) => model.id === 'gpt-5'
    );
    expect(gpt?.inputPriceCents).toBe(10);
  });

  it('rejects a row with no field to change', async () => {
    const active = start();
    insertModel(active.db, 'gpt-5');
    const response = await active.app.inject({
      method: 'POST',
      url: '/console/api/admin/models/bulk',
      headers,
      payload: { rows: [{ id: 'gpt-5' }] }
    });
    expect(response.statusCode).toBe(400);
  });

  it('requires a valid admin assertion', async () => {
    const active = start();
    const response = await active.app.inject({
      method: 'POST',
      url: '/console/api/admin/models/bulk',
      headers: {},
      payload: { rows: [{ id: 'gpt-5', enabled: true }] }
    });
    expect(response.statusCode).toBe(401);
  });
});
