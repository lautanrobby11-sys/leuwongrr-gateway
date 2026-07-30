import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts/store.js';
import { BillingService } from '../src/billing/service.js';
import { GatewayDatabase } from '../src/persistence/database.js';
import { testConfig } from './support/harness.js';

/**
 * The CLI is the only path that can promote the first admin and seed the first
 * plan, so it is exercised as a real process against a real database rather than
 * by importing the module: the module runs its work at import time.
 */
let root: string | null = null;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

function databasePath(): string {
  root = mkdtempSync(join(tmpdir(), 'lwrr-cli-'));
  return join(root, 'gateway.db');
}

function run(path: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/keys.ts', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      API_KEY_PEPPER: testConfig.API_KEY_PEPPER,
      DATABASE_PATH: path
    }
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function withDatabase<T>(path: string, work: (db: GatewayDatabase) => T): T {
  const db = new GatewayDatabase(path, testConfig.API_KEY_PEPPER);
  try {
    return work(db);
  } finally {
    db.close();
  }
}

describe('operator CLI account:role', () => {
  it('promotes an existing account and persists the role', () => {
    const path = databasePath();
    const email = `operator-${randomUUID()}@example.com`;
    const accountId = withDatabase(
      path,
      (db) => new AccountStore(db.db, testConfig.API_KEY_PEPPER).create({ email }).id
    );

    const result = run(path, ['account:role', '--email', email, '--role', 'owner']);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ account_id: accountId, role: 'owner' });
    expect(
      withDatabase(path, (db) => new AccountStore(db.db, testConfig.API_KEY_PEPPER).findById(accountId)?.role)
    ).toBe('owner');
  });

  it('refuses a role outside the schema', () => {
    const path = databasePath();
    const email = `operator-${randomUUID()}@example.com`;
    withDatabase(path, (db) =>
      new AccountStore(db.db, testConfig.API_KEY_PEPPER).create({ email })
    );

    const result = run(path, ['account:role', '--email', email, '--role', 'superuser']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--role must be one of');
  });

  it('refuses an email with no account instead of creating one', () => {
    const path = databasePath();

    const result = run(path, ['account:role', '--email', 'ghost@example.com', '--role', 'admin']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no account with that email');
  });
});

describe('operator CLI plan:upsert', () => {
  it('seeds a plan the console can list', () => {
    const path = databasePath();

    const result = run(path, [
      'plan:upsert',
      '--plan',
      'starter',
      '--name',
      'Starter',
      '--price-cents',
      '0',
      '--included-tokens',
      '0',
      '--overage-cents',
      '400',
      '--daily-units',
      '100000',
      '--max-concurrent',
      '2',
      '--rpm',
      '60'
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: 'starter',
      name: 'Starter',
      overageCentsPerMillion: 400,
      models: ['lwrr-text'],
      active: true
    });
    expect(
      withDatabase(path, (db) => new BillingService(db.db).listPlans(true).map((plan) => plan.id))
    ).toEqual(['starter']);
  });

  it('refuses a model the capability registry does not serve', () => {
    const path = databasePath();

    const result = run(path, [
      'plan:upsert',
      '--plan',
      'starter',
      '--name',
      'Starter',
      '--price-cents',
      '0',
      '--included-tokens',
      '0',
      '--overage-cents',
      '400',
      '--daily-units',
      '100',
      '--max-concurrent',
      '1',
      '--rpm',
      '10',
      '--models',
      'lwrr-imaginary'
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown model: lwrr-imaginary');
  });
});
