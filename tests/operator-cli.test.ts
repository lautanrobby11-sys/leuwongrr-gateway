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

/**
 * Makes the audit insert fail for real, inside the same connection the command
 * uses, without touching the command's own code path. A trigger is the only
 * seam available here: the CLI runs as a separate process, so no module can be
 * stubbed, and the failure has to originate in SQLite for the surrounding
 * transaction to roll back the way a disk or constraint error would.
 */
function breakAuditLog(path: string): void {
  withDatabase(path, (db) =>
    db.db.exec(
      "CREATE TRIGGER audit_logs_unavailable BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_unavailable'); END"
    )
  );
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

  it('records the promotion in audit_logs', () => {
    const path = databasePath();
    const email = `operator-${randomUUID()}@example.com`;
    withDatabase(path, (db) => new AccountStore(db.db, testConfig.API_KEY_PEPPER).create({ email }));

    expect(run(path, ['account:role', '--email', email, '--role', 'admin']).status).toBe(0);

    // Privilege granted outside any HTTP surface still has to be discoverable
    // afterwards; this command is the only path to `admin`.
    const row = withDatabase(path, (db) =>
      db.db
        .prepare("SELECT actor_type, metadata_json FROM audit_logs WHERE event='operator.account.role'")
        .get()
    ) as { actor_type: string; metadata_json: string } | undefined;
    expect(row?.actor_type).toBe('system');
    expect(JSON.parse(row?.metadata_json ?? '{}')).toMatchObject({
      previous_role: 'member',
      role: 'admin'
    });
  });

  /**
   * The promotion and its audit record share one transaction. Without that, a
   * failing audit insert left an owner in `accounts` with nothing recording who
   * granted it — the one thing the audit row exists to prevent.
   */
  it('rolls the role back when the audit insert fails', () => {
    const path = databasePath();
    const email = `operator-${randomUUID()}@example.com`;
    const accountId = withDatabase(
      path,
      (db) => new AccountStore(db.db, testConfig.API_KEY_PEPPER).create({ email }).id
    );
    breakAuditLog(path);

    const result = run(path, ['account:role', '--email', email, '--role', 'owner']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('audit_unavailable');
    expect(
      withDatabase(
        path,
        (db) => new AccountStore(db.db, testConfig.API_KEY_PEPPER).findById(accountId)?.role
      )
    ).toBe('member');
  });
});

describe('operator CLI plan:upsert', () => {
  /**
   * A valid invocation. Appending a flag overrides the earlier occurrence —
   * `parseArgs` keeps the last value for a non-multiple option — so each rejection
   * case differs from the accepted one by exactly one field.
   */
  const PLAN_ARGS = [
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
    '10'
  ];

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

    const result = run(path, [...PLAN_ARGS, '--models', 'lwrr-imaginary']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown model: lwrr-imaginary');
  });

  /**
   * `applyPlanLimits` copies plan values into `tenant_limits`, which the request
   * path enforces, so the CLI has to reject exactly what the console route
   * rejects. Before the shared schema, `--max-concurrent 5000` persisted and
   * became live enforcement state.
   */
  it.each([
    ['--plan', 'Bad Id!', 'id'],
    ['--max-concurrent', '5000', 'maxConcurrent'],
    ['--rpm', '999999', 'rateLimitRpm'],
    ['--price-cents', '999999999', 'monthlyPriceCents'],
    ['--overage-cents', '999999999', 'overageCentsPerMillion'],
    ['--name', 'x'.repeat(65), 'name']
  ])('refuses %s %s outside the shared plan schema', (flag, value, field) => {
    const path = databasePath();

    const result = run(path, [...PLAN_ARGS, flag, value]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`invalid plan: ${field}`);
    expect(withDatabase(path, (db) => new BillingService(db.db).listPlans(true))).toEqual([]);
  });

  /**
   * A plan is live enforcement state: `applyPlanLimits` copies it into
   * `tenant_limits`. A stored envelope change whose audit insert failed would
   * leave no record of who widened it, so the two share one transaction.
   */
  it('rolls the plan back when the audit insert fails', () => {
    const path = databasePath();
    breakAuditLog(path);

    const result = run(path, PLAN_ARGS);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('audit_unavailable');
    expect(withDatabase(path, (db) => new BillingService(db.db).listPlans())).toEqual([]);
  });

  it('leaves an existing plan unchanged when the audit insert fails', () => {
    const path = databasePath();

    expect(run(path, PLAN_ARGS).status).toBe(0);
    breakAuditLog(path);

    const result = run(path, [...PLAN_ARGS, '--rpm', '99']);

    expect(result.status).toBe(1);
    // The upsert would have overwritten rate_limit_rpm in place. Rolling back is
    // what keeps the enforced value and the audit trail describing the same row.
    expect(
      withDatabase(path, (db) => new BillingService(db.db).getPlan('starter')?.rateLimitRpm)
    ).toBe(10);
  });
});
