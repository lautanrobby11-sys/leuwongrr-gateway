import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, jsonResponse, testConfig, type Harness } from './support/harness.js';

let harness: Harness|null=null;
function start(): Harness { harness=createHarness(jsonResponse); return harness; }
afterEach(async()=>{ if(harness){await harness.cleanup();harness=null;} });

describe('HTTP contract',()=>{
  it('keeps liveness minimal and readiness hidden',async()=>{
    const { app }=start();
    expect((await app.inject({method:'GET',url:'/health/live'})).json()).toEqual({status:'ok'});
    expect((await app.inject({method:'GET',url:'/health/ready'})).statusCode).toBe(404);
    expect((await app.inject({method:'GET',url:'/health/ready',headers:{'x-internal-ready-token':testConfig.INTERNAL_READY_TOKEN}})).statusCode).toBe(200);
  });
  it('rejects endpoints outside the allowlist without contacting upstream',async()=>{
    const { app, upstreamCalls }=start();
    expect((await app.inject({method:'POST',url:'/v1/files',payload:{}})).statusCode).toBe(404);
    expect((await app.inject({method:'GET',url:'/admin'})).statusCode).toBe(404);
    expect(upstreamCalls()).toBe(0);
  });
  it('requires an API key and tenant entitlement',async()=>{
    const { app, db, token }=start();
    expect((await app.inject({method:'GET',url:'/v1/models'})).statusCode).toBe(401);
    const allowed=await app.inject({method:'GET',url:'/v1/models',headers:{authorization:`Bearer ${token}`}});
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().data).toHaveLength(1);
    db.db.prepare('UPDATE model_policies SET enabled=0 WHERE tenant_id=?').run('tenant-a');
    const revoked=await app.inject({method:'GET',url:'/v1/models',headers:{authorization:`Bearer ${token}`}});
    expect(revoked.json().data).toHaveLength(0);
  });
  it('rejects capability mismatch before upstream cost',async()=>{
    const { app, token, upstreamCalls }=start();
    const response=await app.inject({method:'POST',url:'/v1/chat/completions',headers:{authorization:`Bearer ${token}`},payload:{model:'lwrr-text',messages:[{role:'user',content:'x'}],tools:[{}]}});
    expect(response.statusCode).toBe(400);
    expect(upstreamCalls()).toBe(0);
  });
  it('replays an idempotent response without a second upstream call',async()=>{
    const { app, token, upstreamCalls }=start();
    const request={method:'POST' as const,url:'/v1/chat/completions',headers:{authorization:`Bearer ${token}`,'idempotency-key':'request-001'},payload:{model:'lwrr-text',messages:[{role:'user',content:'hello'}]}};
    const first=await app.inject(request);
    const second=await app.inject(request);
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(upstreamCalls()).toBe(1);
  });
  it('rejects idempotency key reuse with a different payload',async()=>{
    const { app, token, upstreamCalls }=start();
    const headers={authorization:`Bearer ${token}`,'idempotency-key':'request-002'};
    await app.inject({method:'POST',url:'/v1/chat/completions',headers,payload:{model:'lwrr-text',messages:[{role:'user',content:'one'}]}});
    const conflict=await app.inject({method:'POST',url:'/v1/chat/completions',headers,payload:{model:'lwrr-text',messages:[{role:'user',content:'two'}]}});
    expect(conflict.statusCode).toBe(409);
    expect(upstreamCalls()).toBe(1);
  });
});
