#!/usr/bin/env node
/**
 * Operator helper: create one tenant + API key in a local/runtime database.
 * Prints the plaintext key once to stdout. Never commit the printed value.
 *
 * Usage:
 *   API_KEY_PEPPER=... DATABASE_PATH=./data/gateway.db node scripts/seed-tenant.mjs \
 *     --tenant demo --name "Demo tenant" --scopes models:read,chat:write
 */
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);

function fail(message) {
  console.error(message);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    tenant: { type: 'string' },
    name: { type: 'string' },
    scopes: { type: 'string', default: 'models:read,chat:write' },
    model: { type: 'string', default: 'lwrr-text' },
    mode: { type: 'string', default: 'live' }
  }
});

const tenantId = values.tenant;
if (!tenantId || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(tenantId)) {
  fail('required: --tenant <id> (2-64 chars, alnum/_/-)');
}
const pepper = process.env.API_KEY_PEPPER;
if (!pepper || pepper.length < 32) fail('API_KEY_PEPPER env required (min 32 chars)');
const databasePath = process.env.DATABASE_PATH || './data/gateway.db';
const mode = values.mode === 'test' ? 'test' : 'live';
const scopes = String(values.scopes)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const allowed = new Set([
  'models:read',
  'chat:write',
  'usage:read',
  'responses:write',
  'messages:write',
  'embeddings:write',
  'media:write',
  'files:write',
  'realtime:write'
]);
for (const scope of scopes) {
  if (!allowed.has(scope)) fail(`unsupported scope: ${scope}`);
}

// Load better-sqlite3 from project install when present.
let Database;
try {
  Database = require('better-sqlite3');
} catch {
  fail('better-sqlite3 is required; run npm install first');
}

function hashApiKey(value, keyPepper) {
  return createHmac('sha256', keyPepper).update(value).digest('hex');
}

function issueApiKey(keyPepper, keyMode) {
  const secret = randomBytes(32).toString('base64url');
  const plaintext = `lwrr_${keyMode}_${secret}`;
  return {
    plaintext,
    hash: hashApiKey(plaintext, keyPepper),
    prefix: `lwrr_${keyMode}_`,
    last4: plaintext.slice(-4)
  };
}

mkdirSync(dirname(databasePath), { recursive: true, mode: 0o750 });
const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Ensure core tables exist when seeding a fresh file without running the app first.
db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  last4 TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_policies (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  model_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  PRIMARY KEY(tenant_id, model_id)
);
`);

const now = new Date().toISOString();
const issued = issueApiKey(pepper, mode);
const keyId = randomUUID();
const displayName = values.name || tenantId;

db.transaction(() => {
  db.prepare('INSERT OR IGNORE INTO tenants(id,name,created_at) VALUES(?,?,?)').run(
    tenantId,
    displayName,
    now
  );
  db.prepare(
    'INSERT INTO api_keys(id,tenant_id,key_hash,prefix,last4,scopes_json,created_at) VALUES(?,?,?,?,?,?,?)'
  ).run(keyId, tenantId, issued.hash, issued.prefix, issued.last4, JSON.stringify(scopes), now);
  db.prepare(
    'INSERT INTO model_policies(tenant_id,model_id,enabled) VALUES(?,?,1) ON CONFLICT(tenant_id,model_id) DO UPDATE SET enabled=1'
  ).run(tenantId, values.model);
})();

db.close();

console.log(
  JSON.stringify(
    {
      tenant_id: tenantId,
      key_id: keyId,
      prefix: issued.prefix,
      last4: issued.last4,
      scopes,
      model: values.model,
      api_key_once: issued.plaintext
    },
    null,
    2
  )
);
console.error('Store api_key_once securely. It cannot be recovered from the database.');
