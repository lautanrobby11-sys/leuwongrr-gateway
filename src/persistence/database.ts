import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { MIGRATIONS } from './migrations.js';
import { TenantStore } from './tenant-store.js';
import type { SqliteHandle } from './sqlite.js';
import {
  hashApiKey,
  parseKeyMode,
  parseScopes,
  safeHashEqual,
  type ApiKeyRecord
} from '../auth/api-keys.js';

export type { SqliteHandle } from './sqlite.js';

export interface DatabaseOptions {
  /** Page cache ceiling in KiB. Keeps SQLite predictable on a small VPS. */
  cacheKib?: number;
}

export interface MaintenanceResult {
  expiredIdempotencyKeys: number;
  expiredUsageEvents: number;
  expiredAuditLogs: number;
}

export interface AuditEvent {
  tenantId: string | null;
  actorType: 'api_key' | 'account' | 'admin' | 'system';
  event: string;
  traceId: string;
  metadata?: Record<string, unknown>;
}

interface ApiKeyRow {
  id: string;
  tenant_id: string;
  name: string;
  mode: string;
  key_hash: string;
  prefix: string;
  last4: string;
  scopes_json: string;
  revoked_at: string | null;
  expires_at: string | null;
  last_used_at: string | null;
}

export class GatewayDatabase {
  readonly db: SqliteHandle;
  /** Canonical entry point for tenant and API key lifecycle operations. */
  readonly tenants: TenantStore;
  private readonly pepper: string;

  constructor(path: string, pepper: string, options: DatabaseOptions = {}) {
    this.pepper = pepper;
    mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma(`cache_size = -${options.cacheKib ?? 4096}`);
    this.db.pragma('mmap_size = 0');
    this.db.pragma('wal_autocheckpoint = 512');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)'
    );
    const applied = this.db.prepare('SELECT 1 FROM schema_migrations WHERE id=?');
    const record = this.db.prepare('INSERT INTO schema_migrations(id,applied_at) VALUES(?,?)');
    for (const migration of MIGRATIONS) {
      if (applied.get(migration.id)) continue;
      this.db.transaction(() => {
        this.db.exec(migration.sql);
        record.run(migration.id, new Date().toISOString());
      })();
    }
    this.tenants = new TenantStore(this.db, pepper);
  }

  close(): void {
    this.db.close();
  }

  authenticate(plaintext: string): ApiKeyRecord | null {
    const hash = hashApiKey(plaintext, this.pepper);
    const row = this.db
      .prepare(
        'SELECT id,tenant_id,name,mode,key_hash,prefix,last4,scopes_json,revoked_at,expires_at,last_used_at FROM api_keys WHERE key_hash=?'
      )
      .get(hash) as ApiKeyRow | undefined;
    if (!row || !safeHashEqual(hash, row.key_hash)) return null;

    const nowIso = new Date().toISOString();
    if (row.expires_at && row.expires_at <= nowIso) return null;
    this.tenants.touch(row.id, nowIso, row.last_used_at);

    const scopes = parseScopes(JSON.parse(row.scopes_json) as unknown);
    return {
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      mode: parseKeyMode(row.mode),
      keyHash: row.key_hash,
      prefix: row.prefix,
      last4: row.last4,
      scopes: new Set(scopes),
      revokedAt: row.revoked_at && row.revoked_at <= nowIso ? row.revoked_at : null,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at
    };
  }

  modelEnabled(tenantId: string, modelId: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM model_policies WHERE tenant_id=? AND model_id=? AND enabled=1')
        .get(tenantId, modelId)
    );
  }

  reserveBudget(tenantId: string, requestId: string, units: number, dailyLimit: number): string {
    const day = new Date().toISOString().slice(0, 10);
    const id = randomUUID();
    const tenantLimit = this.tenants.limits(tenantId)?.dailyBudgetUnits ?? dailyLimit;
    const effectiveLimit = Math.min(dailyLimit, tenantLimit);
    this.db.transaction(() => {
      const used = this.db
        .prepare(
          "SELECT COALESCE(SUM(units),0) AS total FROM usage_events WHERE tenant_id=? AND day=? AND state IN ('reserved','settled')"
        )
        .get(tenantId, day) as { total: number };
      if (used.total + units > effectiveLimit) throw new Error('daily_budget_exceeded');
      this.db
        .prepare(
          "INSERT INTO usage_events(id,tenant_id,request_id,units,state,day,created_at) VALUES(?,?,?,?,'reserved',?,?)"
        )
        .run(id, tenantId, requestId, units, day, new Date().toISOString());
    })();
    return id;
  }

  settleBudget(id: string, tenantId: string, actual: number): void {
    this.db
      .prepare(
        "UPDATE usage_events SET units=?, state='settled' WHERE id=? AND tenant_id=? AND state='reserved'"
      )
      .run(actual, id, tenantId);
  }

  releaseBudget(id: string, tenantId: string): void {
    this.db
      .prepare(
        "UPDATE usage_events SET units=0, state='released' WHERE id=? AND tenant_id=? AND state='reserved'"
      )
      .run(id, tenantId);
  }

  audit(event: AuditEvent): void;
  audit(
    tenantId: string | null,
    event: string,
    traceId: string,
    metadata?: Record<string, unknown>
  ): void;
  audit(
    input: AuditEvent | string | null,
    event?: string,
    traceId?: string,
    metadata: Record<string, unknown> = {}
  ): void {
    const record: AuditEvent =
      typeof input === 'object' && input !== null
        ? input
        : {
            tenantId: input,
            actorType: 'api_key',
            event: event ?? 'unknown',
            traceId: traceId ?? 'unknown',
            metadata
          };
    this.db
      .prepare(
        'INSERT INTO audit_logs(id,tenant_id,actor_type,event,trace_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)'
      )
      .run(
        randomUUID(),
        record.tenantId,
        record.actorType,
        record.event,
        record.traceId,
        JSON.stringify(record.metadata ?? {}),
        new Date().toISOString()
      );
  }

  maintain(retentionDays: number): MaintenanceResult {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const cutoffIso = new Date(now - retentionDays * 86_400_000).toISOString();
    const cutoffDay = cutoffIso.slice(0, 10);

    const result = this.db.transaction((): MaintenanceResult => {
      const idempotency = this.db
        .prepare('DELETE FROM idempotency_keys WHERE expires_at<=?')
        .run(nowIso);
      const usage = this.db
        .prepare("DELETE FROM usage_events WHERE day<? AND state IN ('settled','released')")
        .run(cutoffDay);
      const audit = this.db.prepare('DELETE FROM audit_logs WHERE created_at<?').run(cutoffIso);
      return {
        expiredIdempotencyKeys: idempotency.changes,
        expiredUsageEvents: usage.changes,
        expiredAuditLogs: audit.changes
      };
    })();

    this.db.pragma('wal_checkpoint(TRUNCATE)');
    return result;
  }
}
