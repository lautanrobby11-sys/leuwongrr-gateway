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
import { OmniRouteClient } from '../src/upstream.js';
import { testConfig } from './support/harness.js';
import type { Config } from '../src/config.js';

/**
 * One-way catalog import from OmniRoute (`POST /console/api/admin/models/sync`).
 * Uses the real loopback client with a mocked fetcher, so the seam tested is
 * the same one production uses: admin assertion -> GET /v1/models -> create.
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'kid-model-sync';
const TEAM = 'leuwongrr.cloudflareaccess.com';
const AUD = 's'.repeat(32);
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
    sub: 'access-subject-sync',
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

/** The route of the request the mocked upstream actually received. */
let lastUpstreamCall: { method: string; url: string } | null = null;

function start(upstreamBody: unknown, status = 200): Surface {
  root = mkdtempSync(join(tmpdir(), 'lwrr-model-sync-'));
  const config: Config = {
    ...testConfig,
    CONSOLE_ENABLED: true,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD
  };
  const db = new GatewayDatabase(join(root, 'gateway.db'), config.API_KEY_PEPPER);
  const accounts = new AccountStore(db.db, config.API_KEY_PEPPER);
  accounts.create({ email: ADMIN_EMAIL, role: 'admin' });
  const app = Fastify({ genReqId: () => 'trace-model-sync' });
  const certs = (async () =>
    new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })) as unknown as typeof fetch;
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    lastUpstreamCall = {
      method: init?.method ?? 'GET',
      url: String(input)
    };
    return new Response(JSON.stringify(upstreamBody), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  }) as unknown as typeof fetch;
  registerConsole(app, {
    config,
    db,
    accounts,
    billing: new BillingService(db.db),
    payments: new CryptomusClient(config),
    access: new AccessVerifier(TEAM, AUD, 60_000, certs, async () => ['104.16.0.1']),
    logger: createLogger('silent'),
    upstream: new OmniRouteClient('http://127.0.0.1:20128', 4, 5_000, fetcher)
  });
  surface = { app, db };
  return surface;
}

const headers = { 'cf-access-jwt-assertion': assertion() };

describe('admin model sync from OmniRoute', () => {
  it('imports new models disabled and skips existing or invalid ids', async () => {
    const active = start({
      object: 'list',
      data: [
        { id: 'gpt-5', object: 'model' },
        { id: 'gpt-5', object: 'model' }, // duplicate -> skipped
        { id: 'Anthropic.Claude.Opus', object: 'model' }, // slugified
        { id: '!', object: 'model' }, // invalid slug -> skipped
        { id: 'lwrr-text', object: 'model' } // already seeded -> skipped
      ]
    });
    const response = await active.app.inject({
      method: 'POST',
      url: '/console/api/admin/models/sync',
      headers,
      payload: {}
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { synced: boolean; added: string[]; skipped: number };
    expect(body.synced).toBe(true);
    expect(body.added).toEqual(['gpt-5', 'anthropic-claude-opus']);
    expect(body.skipped).toBe(3);
    expect(lastUpstreamCall?.method).toBe('GET');
    expect(lastUpstreamCall?.url).toBe('http://127.0.0.1:20128/v1/models');

    // Imported models are disabled and visible in the catalog.
    const listed = await active.app.inject({ method: 'GET', url: '/console/api/admin/models', headers });
    const catalog = (listed.json() as { catalog: Array<Record<string, unknown>> }).catalog;
    expect(catalog).toHaveLength(3);
    const imported = catalog.find((model) => model.id === 'gpt-5');
    expect(imported?.enabled).toBe(false);
    expect(imported?.upstreamModel).toBe('gpt-5');
  });

  it('fails with 502 when OmniRoute returns a non-JSON or error payload', async () => {
    const active = start({ error: { code: 'UPSTREAM_DOWN' } }, 502);
    const response = await active.app.inject({
      method: 'POST',
      url: '/console/api/admin/models/sync',
      headers,
      payload: {}
    });
    expect(response.statusCode).toBe(502);
    expect((response.json() as { error: { code: string } }).error.code).toBe('sync_upstream_error');
  });

  it('requires a valid admin assertion', async () => {
    const active = start({ object: 'list', data: [] });
    const response = await active.app.inject({
      method: 'POST',
      url: '/console/api/admin/models/sync',
      headers: {},
      payload: {}
    });
    expect(response.statusCode).toBe(401);
  });

  /**
   * Reset mode reconciles the catalog with upstream: a model whose id no
   * longer appears in OmniRoute is removed. Without the toggle, a sync stays
   * additive and old models survive, because the extra removals are
   * irreversible from the console.
   */
  it('keeps stale models when syncing without reset', async () => {
    const active = start({ object: 'list', data: [{ id: 'lwrr-text', object: 'model' }] });
    // A model that has drifted out of the upstream catalog.
    active.db.db
      .prepare(
        "INSERT INTO models (id, public_id, display_name, provider, multimodal, input_price_per_m, output_price_per_m, cache_read_price_per_m, cache_write_price_per_m, enabled, input_price_cents, output_price_cents, cache_read_price_cents, upstream_model, group_id, created_at, updated_at) VALUES ('stale-id', 'stale-model', 'Stale Model', 'other', 0, 0, 0, 0, 0, 0, 0, 0, 0, 'stale', 'legacy-default', datetime('now'), datetime('now'))"
      )
      .run();
    const response = await active.app.inject({
      method: 'POST',
      url: '/console/api/admin/models/sync',
      headers,
      payload: {}
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { added: string[]; removed: string[]; reset: boolean };
    expect(body.removed).toEqual([]);
    expect(body.added).toEqual([]);
    const listed = await active.app.inject({ method: 'GET', url: '/console/api/admin/models', headers });
    expect((listed.json() as { catalog: Array<{ id: string }> }).catalog.map((model) => model.id)).toEqual(
      expect.arrayContaining(['stale-model'])
    );
  });

  it('removes stale models and reports them on reset', async () => {
    const active = start({ object: 'list', data: [{ id: 'lwrr-text', object: 'model' }] });
    active.db.db
      .prepare(
        "INSERT INTO models (id, public_id, display_name, provider, multimodal, input_price_per_m, output_price_per_m, cache_read_price_per_m, cache_write_price_per_m, enabled, input_price_cents, output_price_cents, cache_read_price_cents, upstream_model, group_id, created_at, updated_at) VALUES ('stale-id', 'stale-model', 'Stale Model', 'other', 0, 0, 0, 0, 0, 0, 0, 0, 0, 'stale', 'legacy-default', datetime('now'), datetime('now'))"
      )
      .run();
    const response = await active.app.inject({
      method: 'POST',
      url: '/console/api/admin/models/sync',
      headers,
      payload: { reset: true }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { added: string[]; removed: string[]; keptProtected: string[]; reset: boolean };
    expect(body.removed).toEqual(['stale-model']);
    expect(body.keptProtected).toEqual([]);
    expect(body.reset).toBe(true);
    const listed = await active.app.inject({ method: 'GET', url: '/console/api/admin/models', headers });
    expect((listed.json() as { catalog: Array<{ id: string }> }).catalog.map((model) => model.id)).toEqual(['lwrr-text']);
  });

  it('protects a model an active plan still entitles during reset', async () => {
    const active = start({ object: 'list', data: [{ id: 'lwrr-text', object: 'model' }] });
    active.db.db
      .prepare(
        "INSERT INTO models (id, public_id, display_name, provider, multimodal, input_price_per_m, output_price_per_m, cache_read_price_per_m, cache_write_price_per_m, enabled, input_price_cents, output_price_cents, cache_read_price_cents, upstream_model, group_id, created_at, updated_at) VALUES ('protected-id', 'protected-model', 'Protected Model', 'other', 0, 0, 0, 0, 0, 1, 0, 0, 0, 'protected', 'legacy-default', datetime('now'), datetime('now'))"
      )
      .run();
    // An active plan still references the drifting model, so the entitlement
    // must win against the reconciliation.
    active.db.db
      .prepare(
        `INSERT INTO plans (id, name, monthly_price_cents, included_tokens, overage_cents_per_million, max_concurrent, rate_limit_rpm, daily_budget_units, models_json, active, updated_at)
         VALUES ('plan-a', 'Plan A', 100, 1000, 1, 1, 1, 1, ?, 1, datetime('now'))`
      )
      .run(JSON.stringify(['protected-model']));
    const response = await active.app.inject({
      method: 'POST',
      url: '/console/api/admin/models/sync',
      headers,
      payload: { reset: true }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { added: string[]; removed: string[]; keptProtected: string[] };
    expect(body.removed).toEqual([]);
    expect(body.keptProtected).toEqual(['protected-model']);
    const listed = await active.app.inject({ method: 'GET', url: '/console/api/admin/models', headers });
    expect((listed.json() as { catalog: Array<{ id: string }> }).catalog.map((model) => model.id)).toEqual(
      expect.arrayContaining(['protected-model', 'lwrr-text'])
    );
  });

  it('rejects a sync payload with unknown fields', async () => {
    const active = start({ object: 'list', data: [] });
    const response = await active.app.inject({
      method: 'POST',
      url: '/console/api/admin/models/sync',
      headers,
      payload: { reset: 'yes' }
    });
    expect(response.statusCode).toBe(400);
  });
});
