import type { GatewayDatabase } from './database.js';

export interface CachedResponse { requestHash:string; statusCode:number; body:unknown }
export function getCached(db:GatewayDatabase,tenantId:string,key:string): CachedResponse|null {
  const row = db.db.prepare('SELECT request_hash,status_code,response_json FROM idempotency_keys WHERE tenant_id=? AND key=? AND expires_at>?').get(tenantId,key,new Date().toISOString()) as {request_hash:string;status_code:number|null;response_json:string|null}|undefined;
  if (!row?.status_code || !row.response_json) return null;
  return { requestHash:row.request_hash,statusCode:row.status_code,body:JSON.parse(row.response_json) as unknown };
}
export function putCached(db:GatewayDatabase,tenantId:string,key:string,requestHash:string,statusCode:number,body:unknown) {
  const expiresAt = new Date(Date.now()+24*60*60*1000).toISOString();
  db.db.prepare('INSERT OR REPLACE INTO idempotency_keys(tenant_id,key,request_hash,status_code,response_json,expires_at) VALUES(?,?,?,?,?,?)').run(tenantId,key,requestHash,statusCode,JSON.stringify(body),expiresAt);
}
