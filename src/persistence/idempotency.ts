import type { GatewayDatabase } from './database.js';

export type Claim={state:'owner'}|{state:'cached';statusCode:number;body:unknown}|{state:'conflict'}|{state:'in_progress'};
export function claim(db:GatewayDatabase,tenantId:string,key:string,requestHash:string):Claim {
  return db.db.transaction(():Claim=>{
    db.db.prepare('DELETE FROM idempotency_keys WHERE tenant_id=? AND key=? AND expires_at<=?').run(tenantId,key,new Date().toISOString());
    const expiresAt=new Date(Date.now()+24*60*60*1000).toISOString();
    const inserted=db.db.prepare('INSERT OR IGNORE INTO idempotency_keys(tenant_id,key,request_hash,status_code,response_json,expires_at) VALUES(?,?,?,NULL,NULL,?)').run(tenantId,key,requestHash,expiresAt);
    if(inserted.changes===1)return {state:'owner'};
    const row=db.db.prepare('SELECT request_hash,status_code,response_json FROM idempotency_keys WHERE tenant_id=? AND key=?').get(tenantId,key) as {request_hash:string;status_code:number|null;response_json:string|null};
    if(row.request_hash!==requestHash)return {state:'conflict'};
    if(row.status_code===null||row.response_json===null)return {state:'in_progress'};
    return {state:'cached',statusCode:row.status_code,body:JSON.parse(row.response_json) as unknown};
  })();
}
export function complete(db:GatewayDatabase,tenantId:string,key:string,requestHash:string,statusCode:number,body:unknown){db.db.prepare('UPDATE idempotency_keys SET status_code=?,response_json=? WHERE tenant_id=? AND key=? AND request_hash=? AND status_code IS NULL').run(statusCode,JSON.stringify(body),tenantId,key,requestHash);}
export function abandon(db:GatewayDatabase,tenantId:string,key:string,requestHash:string){db.db.prepare('DELETE FROM idempotency_keys WHERE tenant_id=? AND key=? AND request_hash=? AND status_code IS NULL').run(tenantId,key,requestHash);}
