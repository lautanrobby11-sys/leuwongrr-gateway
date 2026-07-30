/**
 * Operator CLI for tenant and API key lifecycle.
 *
 * Runs against the same tenant store the gateway uses, so a credential issued
 * here is always verifiable by the running service.
 *
 *   API_KEY_PEPPER=... DATABASE_PATH=/opt/leuwongrr-gateway/data/gateway.db \
 *     node dist/cli/keys.js key:issue --tenant demo --scopes models:read,chat:write
 */
import { parseArgs } from 'node:util';
import { GatewayDatabase } from '../persistence/database.js';
import { isScope, parseKeyMode, SCOPES, type Scope } from '../auth/api-keys.js';
import { AccountStore, type AccountRole } from '../accounts/store.js';
import { BillingService } from '../billing/service.js';
import { DEFAULT_DATABASE_PATH } from '../config.js';
import { listModels } from '../policy/capabilities.js';

const ACCOUNT_ROLES: readonly AccountRole[] = ['member', 'support', 'operator', 'admin', 'owner'];

const USAGE = `Usage: node dist/cli/keys.js <command> [options]

Commands:
  tenant:create   --tenant <id> [--name <label>] [--model <id>]
  key:issue       --tenant <id> [--name <label>] [--scopes a,b] [--mode live|test] [--expires-days N]
  key:list        --tenant <id>
  key:revoke      --tenant <id> --key <key-id>
  key:rotate      --tenant <id> --key <key-id> [--grace-minutes N] [--expires-days N]
  limits:set      --tenant <id> --daily-units N --max-concurrent N --rpm N
  model:enable    --tenant <id> --model <id>
  model:disable   --tenant <id> --model <id>
  account:role    --email <address> --role ${ACCOUNT_ROLES.join('|')}
  plan:upsert     --plan <id> --name <label> --price-cents N --included-tokens N
                  --overage-cents N --daily-units N --max-concurrent N --rpm N
                  [--models a,b] [--inactive]

Notes:
  account:role only sets the database role. Admin console routes additionally
  require a verified Cloudflare Access assertion, so a role change alone does
  not grant access.
  plan:upsert is the bootstrap path for the first plan; once an admin exists the
  console owns plan edits at POST /console/api/admin/plans.

Environment:
  API_KEY_PEPPER  required, minimum 32 characters
  DATABASE_PATH   defaults to ${DEFAULT_DATABASE_PATH}

Scopes: ${SCOPES.join(', ')}`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function emit(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function requireOption(value: string | undefined, name: string): string {
  if (!value) fail(`required: --${name}`);
  return value;
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(requireOption(value, name));
  if (!Number.isInteger(parsed) || parsed < 1) fail(`--${name} must be a positive integer`);
  return parsed;
}

/**
 * Plan prices, included tokens, overage and daily units legitimately accept 0,
 * matching the `min(0)` schema the console applies at POST /admin/plans. Kept
 * separate from positiveInteger so tenant limit validation is unchanged.
 */
function nonNegativeInteger(value: string | undefined, name: string): number {
  const parsed = Number(requireOption(value, name));
  if (!Number.isInteger(parsed) || parsed < 0) fail(`--${name} must be a non-negative integer`);
  return parsed;
}

function parseModelList(raw: string): string[] {
  const requested = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const known = new Set(listModels().map((model) => model.publicId));
  const unknown = requested.filter((entry) => !known.has(entry));
  if (unknown.length > 0) fail(`unknown model: ${unknown.join(', ')}`);
  return requested;
}

function parseScopeList(raw: string): Scope[] {
  const requested = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const unknown = requested.filter((entry) => !isScope(entry));
  if (unknown.length > 0) fail(`unsupported scope: ${unknown.join(', ')}`);
  return requested.filter(isScope);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tenant: { type: 'string' },
    name: { type: 'string' },
    key: { type: 'string' },
    scopes: { type: 'string', default: 'models:read,chat:write' },
    mode: { type: 'string', default: 'live' },
    model: { type: 'string' },
    'expires-days': { type: 'string' },
    'grace-minutes': { type: 'string' },
    'daily-units': { type: 'string' },
    'max-concurrent': { type: 'string' },
    rpm: { type: 'string' },
    email: { type: 'string' },
    role: { type: 'string' },
    plan: { type: 'string' },
    'price-cents': { type: 'string' },
    'included-tokens': { type: 'string' },
    'overage-cents': { type: 'string' },
    models: { type: 'string' },
    inactive: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false }
  }
});

const command = positionals[0];
if (values.help || !command) {
  console.log(USAGE);
  process.exit(command ? 0 : 1);
}

const pepper = process.env.API_KEY_PEPPER;
if (!pepper || pepper.length < 32) fail('API_KEY_PEPPER environment variable required (min 32 chars)');

const databasePath = process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH;
const db = new GatewayDatabase(databasePath, pepper);

try {
  switch (command) {
    case 'tenant:create': {
      const tenant = requireOption(values.tenant, 'tenant');
      db.tenants.upsertTenant(tenant, values.name ?? tenant);
      if (values.model) db.tenants.setModelPolicy(tenant, values.model, true);
      emit({ tenant_id: tenant, model: values.model ?? null });
      break;
    }
    case 'key:issue': {
      const tenant = requireOption(values.tenant, 'tenant');
      const issued = db.tenants.issue({
        tenantId: tenant,
        name: values.name ?? 'operator-issued',
        scopes: parseScopeList(values.scopes ?? ''),
        mode: parseKeyMode(values.mode),
        expiresInDays: values['expires-days']
          ? positiveInteger(values['expires-days'], 'expires-days')
          : undefined
      });
      emit({ ...issued.key, api_key_once: issued.plaintext });
      console.error('Store api_key_once securely. It cannot be recovered from the database.');
      break;
    }
    case 'key:list': {
      emit(db.tenants.list(requireOption(values.tenant, 'tenant')));
      break;
    }
    case 'key:revoke': {
      const tenant = requireOption(values.tenant, 'tenant');
      const keyId = requireOption(values.key, 'key');
      if (!db.tenants.revoke(tenant, keyId)) fail('no active key matched that tenant and key id');
      emit({ tenant_id: tenant, key_id: keyId, revoked: true });
      break;
    }
    case 'key:rotate': {
      const tenant = requireOption(values.tenant, 'tenant');
      const keyId = requireOption(values.key, 'key');
      const rotated = db.tenants.rotate(tenant, keyId, {
        graceMinutes: values['grace-minutes']
          ? positiveInteger(values['grace-minutes'], 'grace-minutes')
          : 0,
        expiresInDays: values['expires-days']
          ? positiveInteger(values['expires-days'], 'expires-days')
          : undefined
      });
      emit({ ...rotated.key, api_key_once: rotated.plaintext });
      console.error('Store api_key_once securely. It cannot be recovered from the database.');
      break;
    }
    case 'limits:set': {
      const tenant = requireOption(values.tenant, 'tenant');
      const limits = {
        dailyBudgetUnits: positiveInteger(values['daily-units'], 'daily-units'),
        maxConcurrent: positiveInteger(values['max-concurrent'], 'max-concurrent'),
        rateLimitRpm: positiveInteger(values.rpm, 'rpm')
      };
      db.tenants.setLimits(tenant, limits);
      emit({ tenant_id: tenant, ...limits });
      break;
    }
    case 'model:enable':
    case 'model:disable': {
      const tenant = requireOption(values.tenant, 'tenant');
      const model = requireOption(values.model, 'model');
      const enabled = command === 'model:enable';
      db.tenants.setModelPolicy(tenant, model, enabled);
      emit({ tenant_id: tenant, model_id: model, enabled });
      break;
    }
    case 'account:role': {
      const email = requireOption(values.email, 'email');
      const role = requireOption(values.role, 'role');
      if (!ACCOUNT_ROLES.includes(role as AccountRole)) {
        fail(`--role must be one of: ${ACCOUNT_ROLES.join(', ')}`);
      }
      const accounts = new AccountStore(db.db, pepper);
      const account = accounts.findByEmail(email);
      if (!account) fail('no account with that email; the member must sign in once first');
      accounts.setRole(account.id, role as AccountRole);
      emit({ account_id: account.id, email: account.email, role });
      console.error(
        'Role updated. Admin console routes still require a verified Cloudflare Access assertion.'
      );
      break;
    }
    case 'plan:upsert': {
      const billing = new BillingService(db.db);
      const stored = billing.upsertPlan({
        id: requireOption(values.plan, 'plan'),
        name: requireOption(values.name, 'name'),
        monthlyPriceCents: nonNegativeInteger(values['price-cents'], 'price-cents'),
        includedTokens: nonNegativeInteger(values['included-tokens'], 'included-tokens'),
        overageCentsPerMillion: nonNegativeInteger(values['overage-cents'], 'overage-cents'),
        maxConcurrent: positiveInteger(values['max-concurrent'], 'max-concurrent'),
        rateLimitRpm: positiveInteger(values.rpm, 'rpm'),
        dailyBudgetUnits: nonNegativeInteger(values['daily-units'], 'daily-units'),
        models: parseModelList(values.models ?? 'lwrr-text'),
        active: !values.inactive
      });
      emit(stored);
      break;
    }
    default:
      console.error(USAGE);
      fail(`unknown command: ${command}`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : 'command failed');
} finally {
  db.close();
}
