import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { GatewayDatabase } from '../../src/persistence/database.js';
import { OmniRouteClient } from '../../src/upstream.js';
import { createLogger } from '../../src/observability.js';
import { issueApiKey, type Scope } from '../../src/auth/api-keys.js';
import type { Config } from '../../src/config.js';

export const testConfig: Config = {
  GATEWAY_HOST: '127.0.0.1',
  GATEWAY_PORT: 2080,
  OMNIROUTE_URL: 'http://127.0.0.1:20128',
  DATABASE_PATH: 'unused',
  API_KEY_PEPPER: 'p'.repeat(32),
  INTERNAL_READY_TOKEN: 'r'.repeat(32),
  LOG_LEVEL: 'silent',
  UPSTREAM_CONCURRENCY: 2,
  REQUEST_TIMEOUT_MS: 1000,
  DAILY_BUDGET_UNITS: 10000,
  RATE_LIMIT_RPM: 120,
  RATE_LIMIT_BURST: 30,
  RATE_LIMIT_MAX_ENTRIES: 256,
  STREAM_IDLE_TIMEOUT_MS: 5000,
  SQLITE_CACHE_KIB: 1024,
  RETENTION_DAYS: 90,
  MAINTENANCE_INTERVAL_MS: 3_600_000
};

export interface Harness {
  app: ReturnType<typeof buildApp>;
  db: GatewayDatabase;
  token: string;
  upstreamCalls: () => number;
  cleanup: () => Promise<void>;
}

export function createTempDatabase(): { db: GatewayDatabase; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'lwrr-'));
  const db = new GatewayDatabase(join(root, 'gateway.db'), testConfig.API_KEY_PEPPER, {
    cacheKib: testConfig.SQLITE_CACHE_KIB
  });
  return {
    db,
    dispose: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

export function seedTenant(db: GatewayDatabase, tenantId: string, scopes: Scope[]): string {
  const issued = issueApiKey(testConfig.API_KEY_PEPPER);
  const now = new Date().toISOString();
  db.db.prepare('INSERT OR IGNORE INTO tenants(id,name,created_at) VALUES(?,?,?)').run(tenantId, tenantId, now);
  db.db
    .prepare('INSERT INTO api_keys(id,tenant_id,key_hash,prefix,last4,scopes_json,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(`key-${tenantId}`, tenantId, issued.hash, issued.prefix, issued.last4, JSON.stringify(scopes), now);
  return issued.plaintext;
}

export function createHarness(
  respond: () => Response,
  overrides: Partial<Config> = {}
): Harness {
  const config: Config = { ...testConfig, ...overrides };
  const root = mkdtempSync(join(tmpdir(), 'lwrr-http-'));
  const db = new GatewayDatabase(join(root, 'gateway.db'), config.API_KEY_PEPPER, {
    cacheKib: config.SQLITE_CACHE_KIB
  });
  const token = seedTenant(db, 'tenant-a', ['models:read', 'chat:write']);
  db.db.prepare('INSERT INTO model_policies(tenant_id,model_id,enabled) VALUES(?,?,1)').run('tenant-a', 'lwrr-text');
  const fetcher = vi.fn(async () => respond());
  const upstream = new OmniRouteClient(
    config.OMNIROUTE_URL,
    config.UPSTREAM_CONCURRENCY,
    config.REQUEST_TIMEOUT_MS,
    fetcher as unknown as typeof fetch
  );
  const app = buildApp({
    config,
    db,
    upstream,
    logger: createLogger('silent')
  });
  return {
    app,
    db,
    token,
    upstreamCalls: () => fetcher.mock.calls.length,
    cleanup: async () => {
      await app.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

export function jsonResponse(): Response {
  return new Response(JSON.stringify({ id: 'chatcmpl_mock', choices: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}
