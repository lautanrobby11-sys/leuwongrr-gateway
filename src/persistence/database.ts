import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { MIGRATIONS } from './migrations.js';
import { hashApiKey, safeHashEqual, type ApiKeyRecord, type Scope } from '../auth/api-keys.js';

export type SqliteHandle = InstanceType<typeof Database>;
interface ApiKeyRow { id:string; tenant_id:string; key_hash:string; prefix:string; last4:string; scopes_json:string; revoked_at:string|null }

export class GatewayDatabase {
  readonly db: SqliteHandle;
  private readonly pepper: string;
  constructor(path: string, pepper: string) {
    this.pepper = pepper;
    mkdirSync(dirname(path), { recursive:true, mode:0o750 });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied=this.db.prepare('SELECT 1 FROM schema_migrations WHERE id=?');
    const record=this.db.prepare('INSERT INTO schema_migrations(id,applied_at) VALUES(?,?)');
    for(const migration of MIGRATIONS){
      if(applied.get(migration.id))continue;
      this.db.transaction(()=>{this.db.exec(migration.sql);record.run(migration.id,new Date().toISOString());})();
    }
  }
  close(){ this.db.close(); }
  authenticate(plaintext:string): ApiKeyRecord|null {
    const hash=hashApiKey(plaintext,this.pepper);
    const row=this.db.prepare('SELECT id,tenant_id,key_hash,prefix,last4,scopes_json,revoked_at FROM api_keys WHERE key_hash=?').get(hash) as ApiKeyRow|undefined;
    if(!row||!safeHashEqual(hash,row.key_hash))return null;
    const scopes=JSON.parse(row.scopes_json) as Scope[];
    return { id:row.id, tenantId:row.tenant_id, keyHash:row.key_hash, prefix:row.prefix, last4:row.last4, scopes:new Set(scopes), revokedAt:row.revoked_at };
  }
  modelEnabled(tenantId:string,modelId:string):boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM model_policies WHERE tenant_id=? AND model_id=? AND enabled=1').get(tenantId,modelId));
  }
  reserveBudget(tenantId:string,requestId:string,units:number,dailyLimit:number):string {
    const day=new Date().toISOString().slice(0,10);
    const id=randomUUID();
    this.db.transaction(()=>{
      const used=this.db.prepare("SELECT COALESCE(SUM(units),0) AS total FROM usage_events WHERE tenant_id=? AND day=? AND state IN ('reserved','settled')").get(tenantId,day) as {total:number};
      if(used.total+units>dailyLimit)throw new Error('daily_budget_exceeded');
      this.db.prepare("INSERT INTO usage_events(id,tenant_id,request_id,units,state,day,created_at) VALUES(?,?,?,?,'reserved',?,?)").run(id,tenantId,requestId,units,day,new Date().toISOString());
    })();
    return id;
  }
  settleBudget(id:string,tenantId:string,actual:number){ this.db.prepare("UPDATE usage_events SET units=?, state='settled' WHERE id=? AND tenant_id=? AND state='reserved'").run(actual,id,tenantId); }
  releaseBudget(id:string,tenantId:string){ this.db.prepare("UPDATE usage_events SET units=0, state='released' WHERE id=? AND tenant_id=? AND state='reserved'").run(id,tenantId); }
  audit(tenantId:string|null,event:string,traceId:string,metadata:Record<string,unknown>={}){ this.db.prepare('INSERT INTO audit_logs(id,tenant_id,actor_type,event,trace_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),tenantId,'api_key',event,traceId,JSON.stringify(metadata),new Date().toISOString()); }
}
