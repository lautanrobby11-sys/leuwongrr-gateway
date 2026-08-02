import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { closeActiveStreams } from '../../src/http/stream-lifecycle.js';
import { GatewayDatabase } from '../../src/persistence/database.js';
import { OmniRouteClient } from '../../src/upstream.js';
import { createLogger } from '../../src/observability.js';
import { type Scope } from '../../src/auth/api-keys.js';
import type { Config } from '../../src/config.js';

export const testConfig: Config = {
  /**
   * ADR-010: production fails closed on development OTP delivery. Tests run
   * offline, so the fixture is pinned to the test environment instead of
   * inheriting the production default.
   */
  NODE_ENV: 'test',
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
  UPSTREAM_CONTEXT_OVERHEAD_UNITS: 2200,
  RATE_LIMIT_RPM: 120,
  RATE_LIMIT_BURST: 30,
  RATE_LIMIT_MAX_ENTRIES: 256,
  STREAM_IDLE_TIMEOUT_MS: 5000,
  SQLITE_CACHE_KIB: 1024,
  RETENTION_DAYS: 90,
  MAINTENANCE_INTERVAL_MS: 3_600_000,
  TRUST_PROXY: false,
  TRUSTED_CLIENT_IP_HEADER: 'cf-connecting-ip',
  READY_UPSTREAM_TIMEOUT_MS: 2000,
  TENANT_MAX_CONCURRENT: 2,
  TENANT_LIMIT_MAX_ENTRIES: 256,
  /** ADR-011: observability is opt-in, so the default fixture keeps it shut. */
  METRICS_ENABLED: false,
  CONSOLE_ENABLED: false,
  PUBLIC_BASE_URL: 'http://127.0.0.1:2080',
  WEB_DIST_PATH: './dist/public',
  SESSION_COOKIE_NAME: 'lwrr_test_session',
  SESSION_TTL_HOURS: 1,
  OTP_TTL_MINUTES: 10,
  OTP_MAX_ATTEMPTS: 5,
  OTP_RESEND_SECONDS: 60,
  OTP_DELIVERY: 'log',
  CRYPTOMUS_API_URL: 'https://api.cryptomus.com',
  CRYPTOMUS_TIMEOUT_MS: 15000
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
      closeActiveStreams(db);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

/**
 * Provisions through the canonical store so tests exercise the real path.
 * Issue #47: a tenant now gets an explicit conservative row on creation, so
 * the harness must act like an operator who raises the limit to the fixture
 * value; otherwise the 1000-unit default rejects every metered request.
 * `overrides` lets tests that override concurrency/budget in the config keep
 * the stored row aligned with the config they exercise.
 */
export function seedTenant(
  db: GatewayDatabase,
  tenantId: string,
  scopes: Scope[],
  limits: { dailyBudgetUnits: number; maxConcurrent: number; rateLimitRpm: number } = {
    dailyBudgetUnits: testConfig.DAILY_BUDGET_UNITS,
    maxConcurrent: testConfig.TENANT_MAX_CONCURRENT,
    rateLimitRpm: testConfig.RATE_LIMIT_RPM
  }
): string {
  db.tenants.upsertTenant(tenantId, tenantId);
  db.tenants.setLimits(tenantId, limits);
  return db.tenants.issue({ tenantId, name: 'harness', scopes }).plaintext;
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
  const token = seedTenant(db, 'tenant-a', ['models:read', 'chat:write'], {
    dailyBudgetUnits: config.DAILY_BUDGET_UNITS,
    maxConcurrent: config.TENANT_MAX_CONCURRENT,
    rateLimitRpm: config.RATE_LIMIT_RPM
  });
  db.tenants.setModelPolicy('tenant-a', 'lwrr-text', true);
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
      closeActiveStreams(db);
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
