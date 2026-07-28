import { afterEach,describe,expect,it } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { issueApiKey,bearerToken,requireScope,AuthError } from '../src/auth/api-keys.js';
import { GatewayDatabase } from '../src/persistence/database.js';

const roots:string[]=[]; function makeDb(){const root=mkdtempSync(join(tmpdir(),'lwrr-'));roots.push(root);return new GatewayDatabase(join(root,'gateway.db'),'p'.repeat(32));}
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
describe('API key lifecycle',()=>{
  it('stores only a hash and authenticates tenant/scopes',()=>{const db=makeDb();const key=issueApiKey('p'.repeat(32));db.db.prepare('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)').run('tenant-a','A',new Date().toISOString());db.db.prepare('INSERT INTO api_keys(id,tenant_id,key_hash,prefix,last4,scopes_json,created_at) VALUES(?,?,?,?,?,?,?)').run('key-a','tenant-a',key.hash,key.prefix,key.last4,JSON.stringify(['models:read']),new Date().toISOString());const record=db.authenticate(key.plaintext);expect(record?.tenantId).toBe('tenant-a');expect(JSON.stringify(db.db.prepare('SELECT * FROM api_keys').get())).not.toContain(key.plaintext);requireScope(record!,'models:read');expect(()=>requireScope(record!,'chat:write')).toThrow(AuthError);db.close();});
  it('uses strict bearer grammar',()=>{expect(bearerToken('Basic abc')).toBeNull();expect(bearerToken('Bearer not-a-key')).toBeNull();});
});
describe('tenant budget isolation',()=>{
  it('counts reservations per tenant and never updates another tenant',()=>{const db=makeDb();for(const id of ['a','b'])db.db.prepare('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)').run(id,id,new Date().toISOString());const a=db.reserveBudget('a','r1',60,100);expect(()=>db.reserveBudget('a','r2',50,100)).toThrow('daily_budget_exceeded');expect(()=>db.reserveBudget('b','r3',50,100)).not.toThrow();db.settleBudget(a,'b',1);const row=db.db.prepare('SELECT units,state FROM usage_events WHERE id=?').get(a) as {units:number;state:string};expect(row).toEqual({units:60,state:'reserved'});db.close();});
});
