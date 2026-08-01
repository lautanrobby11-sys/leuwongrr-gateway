import { randomUUID } from 'node:crypto';
import type { SqliteHandle } from './sqlite.js';
import {
  issueApiKey,
  parseKeyMode,
  parseScopes,
  type KeyMode,
  type Scope
} from '../auth/api-keys.js';

export interface ApiKeySummary {
  id: string;
  tenantId: string;
  name: string;
  mode: KeyMode;
  prefix: string;
  last4: string;
  scopes: Scope[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  rotatedFrom: string | null;
}

export interface IssuedKey {
  /** Metadata safe to log, list, or display. */
  key: ApiKeySummary;
  /** Shown once at issuance and never recoverable afterwards. */
  plaintext: string;
}

export interface TenantLimits {
  dailyBudgetUnits: number;
  maxConcurrent: number;
  rateLimitRpm: number;
}

/**
 * What the request path will actually enforce for a tenant, plus whether a
 * stored `tenant_limits` row supplied it.
 *
 * The admin editor needs this rather than the subscribed plan: a plan is only
 * the value `applyPlanLimits` last copied in, so after any direct limit edit the
 * plan no longer describes what is enforced, and an editor seeded from the plan
 * silently reverts that edit on save.
 */
export interface EffectiveTenantLimits extends TenantLimits {
  stored: boolean;
}

export interface IssueInput {
  tenantId: string;
  name: string;
  scopes: readonly Scope[];
  mode?: KeyMode;
  expiresInDays?: number;
  rotatedFrom?: string;
}

interface KeyRow {
  id: string;
  tenant_id: string;
  name: string;
  mode: string;
  prefix: string;
  last4: string;
  scopes_json: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  rotated_from: string | null;
}

interface LimitRow {
  daily_budget_units: number;
  max_concurrent: number;
  rate_limit_rpm: number;
}

const SELECT_COLUMNS =
  'id,tenant_id,name,mode,prefix,last4,scopes_json,created_at,expires_at,revoked_at,last_used_at,rotated_from';

/** Writing last_used_at on every request would add avoidable disk churn. */
const TOUCH_INTERVAL_MS = 60_000;

export class TenantStoreError extends Error {}

/**
 * Single owner of tenant provisioning: tenants, API key lifecycle, model
 * policy, and per-tenant limits. The service, the operator CLI, and tests all
 * issue credentials through here so a key can never be created in a shape the
 * gateway is unable to verify.
 */
export class TenantStore {
  constructor(
    private readonly db: SqliteHandle,
    private readonly pepper: string
  ) {}

  upsertTenant(id: string, name: string): void {
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(id)) {
      throw new TenantStoreError('tenant id must be 2-64 chars of letters, digits, dash, underscore');
    }
    this.db
      .prepare(
        'INSERT INTO tenants(id,name,created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name'
      )
      .run(id, name || id, new Date().toISOString());
  }

  tenantExists(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM tenants WHERE id=?').get(id));
  }

  setModelPolicy(tenantId: string, modelId: string, enabled: boolean): void {
    if (!this.tenantExists(tenantId)) throw new TenantStoreError(`unknown tenant: ${tenantId}`);
    this.db
      .prepare(
        'INSERT INTO model_policies(tenant_id,model_id,enabled) VALUES(?,?,?) ON CONFLICT(tenant_id,model_id) DO UPDATE SET enabled=excluded.enabled'
      )
      .run(tenantId, modelId, enabled ? 1 : 0);
  }

  issue(input: IssueInput): IssuedKey {
    if (!this.tenantExists(input.tenantId)) {
      throw new TenantStoreError(`unknown tenant: ${input.tenantId}`);
    }
    const scopes = parseScopes(input.scopes as unknown);
    if (scopes.length === 0) throw new TenantStoreError('at least one valid scope is required');
    if (input.expiresInDays !== undefined && input.expiresInDays <= 0) {
      throw new TenantStoreError('expiresInDays must be greater than zero');
    }

    const mode = input.mode ?? 'live';
    const issued = issueApiKey(this.pepper, mode);
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt =
      input.expiresInDays === undefined
        ? null
        : new Date(now.getTime() + input.expiresInDays * 86_400_000).toISOString();
    const id = randomUUID();

    this.db
      .prepare(
        'INSERT INTO api_keys(id,tenant_id,name,mode,key_hash,prefix,last4,scopes_json,expires_at,rotated_from,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        id,
        input.tenantId,
        input.name || 'unnamed',
        mode,
        issued.hash,
        issued.prefix,
        issued.last4,
        JSON.stringify(scopes),
        expiresAt,
        input.rotatedFrom ?? null,
        createdAt
      );

    return {
      plaintext: issued.plaintext,
      key: {
        id,
        tenantId: input.tenantId,
        name: input.name || 'unnamed',
        mode,
        prefix: issued.prefix,
        last4: issued.last4,
        scopes,
        createdAt,
        expiresAt,
        revokedAt: null,
        lastUsedAt: null,
        rotatedFrom: input.rotatedFrom ?? null
      }
    };
  }

  list(tenantId: string): ApiKeySummary[] {
    const rows = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM api_keys WHERE tenant_id=? ORDER BY created_at DESC`)
      .all(tenantId) as KeyRow[];
    return rows.map((row) => toSummary(row));
  }

  find(tenantId: string, keyId: string): ApiKeySummary | null {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM api_keys WHERE tenant_id=? AND id=?`)
      .get(tenantId, keyId) as KeyRow | undefined;
    return row ? toSummary(row) : null;
  }

  /** Revocation is scoped by tenant so one tenant can never revoke another's key. */
  revoke(tenantId: string, keyId: string, at: string = new Date().toISOString()): boolean {
    const result = this.db
      .prepare('UPDATE api_keys SET revoked_at=? WHERE tenant_id=? AND id=? AND revoked_at IS NULL')
      .run(at, tenantId, keyId);
    return result.changes > 0;
  }

  /**
   * Issues a replacement carrying the same name, scopes, and mode. The previous
   * key stays valid for the grace window so callers can be migrated without a
   * gap in service.
   */
  rotate(
    tenantId: string,
    keyId: string,
    options: { expiresInDays?: number; graceMinutes?: number } = {}
  ): IssuedKey {
    const existing = this.find(tenantId, keyId);
    if (!existing) throw new TenantStoreError(`unknown key: ${keyId}`);
    if (existing.revokedAt) throw new TenantStoreError('key is already revoked');

    const graceMinutes = Math.max(0, options.graceMinutes ?? 0);
    const retireAt = new Date(Date.now() + graceMinutes * 60_000).toISOString();

    return this.db.transaction((): IssuedKey => {
      const replacement = this.issue({
        tenantId,
        name: existing.name,
        scopes: existing.scopes,
        mode: existing.mode,
        expiresInDays: options.expiresInDays,
        rotatedFrom: existing.id
      });
      this.db
        .prepare('UPDATE api_keys SET revoked_at=? WHERE tenant_id=? AND id=?')
        .run(retireAt, tenantId, existing.id);
      return replacement;
    })();
  }

  touch(keyId: string, nowIso: string, lastUsedAt: string | null): void {
    if (lastUsedAt && Date.parse(nowIso) - Date.parse(lastUsedAt) < TOUCH_INTERVAL_MS) return;
    this.db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(nowIso, keyId);
  }

  limits(tenantId: string): TenantLimits | null {
    const row = this.db
      .prepare(
        'SELECT daily_budget_units,max_concurrent,rate_limit_rpm FROM tenant_limits WHERE tenant_id=?'
      )
      .get(tenantId) as LimitRow | undefined;
    if (!row) return null;
    return {
      dailyBudgetUnits: row.daily_budget_units,
      maxConcurrent: row.max_concurrent,
      rateLimitRpm: row.rate_limit_rpm
    };
  }

  /**
   * The stored row when one exists, otherwise the process defaults the request
   * path falls back to. Returned verbatim rather than clamped: an editor seeded
   * with a clamped value would write the clamp back and lower the row on save.
   * `reserveBudget` still applies the `DAILY_BUDGET_UNITS` ceiling at spend time.
   */
  effectiveLimits(tenantId: string, defaults: TenantLimits): EffectiveTenantLimits {
    const stored = this.limits(tenantId);
    return stored ? { ...stored, stored: true } : { ...defaults, stored: false };
  }

  setLimits(tenantId: string, limits: TenantLimits): void {
    if (!this.tenantExists(tenantId)) throw new TenantStoreError(`unknown tenant: ${tenantId}`);
    // NaN fails every `<` comparison, so a range check alone accepted it and
    // SQLite then stored NULL in a NOT NULL column, or a float where the
    // enforcement path expects units. Finiteness and integrality come first.
    for (const [field, value] of Object.entries(limits)) {
      if (!Number.isInteger(value)) {
        throw new TenantStoreError(`${field} must be a finite integer`);
      }
    }
    if (limits.dailyBudgetUnits < 0 || limits.maxConcurrent < 1 || limits.rateLimitRpm < 1) {
      throw new TenantStoreError('limits must be non-negative with positive concurrency and rate');
    }
    this.db
      .prepare(
        'INSERT INTO tenant_limits(tenant_id,daily_budget_units,max_concurrent,rate_limit_rpm,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET daily_budget_units=excluded.daily_budget_units, max_concurrent=excluded.max_concurrent, rate_limit_rpm=excluded.rate_limit_rpm, updated_at=excluded.updated_at'
      )
      .run(
        tenantId,
        limits.dailyBudgetUnits,
        limits.maxConcurrent,
        limits.rateLimitRpm,
        new Date().toISOString()
      );
  }
}

function toSummary(row: KeyRow): ApiKeySummary {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    mode: parseKeyMode(row.mode),
    prefix: row.prefix,
    last4: row.last4,
    scopes: parseScopes(JSON.parse(row.scopes_json) as unknown),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    rotatedFrom: row.rotated_from
  };
}
