import { describe, expect, it, vi } from 'vitest';
import { OmniRouteClient } from '../src/upstream.js';
import { OverloadError } from '../src/policy/semaphore.js';

describe('upstream resource envelope',()=>{
  it('holds the permit until the response body is consumed',async()=>{
    let controller: ReadableStreamDefaultController<Uint8Array>|null=null;
    const fetcher=vi.fn(async()=>new Response(new ReadableStream<Uint8Array>({start(c){controller=c;}})));
    const client=new OmniRouteClient('http://127.0.0.1:20128',1,1000,fetcher as unknown as typeof fetch);
    const first=await client.request('/v1/chat/completions',{method:'POST'});
    await expect(client.request('/v1/chat/completions',{method:'POST'})).rejects.toBeInstanceOf(OverloadError);
    if(!controller)throw new Error('expected stream controller');
    (controller as ReadableStreamDefaultController<Uint8Array>).close();
    await first.text();
    await expect(client.request('/v1/chat/completions',{method:'POST'})).resolves.toBeInstanceOf(Response);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('releases the permit when the upstream call fails',async()=>{
    const fetcher=vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(new Response('{}'));
    const client=new OmniRouteClient('http://127.0.0.1:20128',1,1000,fetcher as unknown as typeof fetch);
    await expect(client.request('/v1/models',{method:'GET'})).rejects.toThrow('network');
    await expect(client.request('/v1/models',{method:'GET'})).resolves.toBeInstanceOf(Response);
  });
});

describe('upstream credential',()=>{
  it('sends the configured credential, overrides caller auth, and preserves safe headers',async()=>{
    let seen: Headers|null=null;
    const credential='k'.repeat(32);
    const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{ seen=new Headers(init?.headers); return new Response('{}'); });
    const client=new OmniRouteClient('http://127.0.0.1:20128',1,1000,fetcher as unknown as typeof fetch,credential);
    await (await client.request('/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer caller-secret','content-type':'application/json','x-request-id':'req-1'}})).text();
    if(!seen)throw new Error('expected captured headers');
    const headers=seen as Headers;
    expect(headers.get('authorization')).toBe(`Bearer ${credential}`);
    expect(headers.get('authorization')).not.toContain('caller-secret');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-request-id')).toBe('req-1');
  });
  it('sends no authorization header when no credential is configured',async()=>{
    let seen: Headers|null=null;
    const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{ seen=new Headers(init?.headers); return new Response('{}'); });
    const client=new OmniRouteClient('http://127.0.0.1:20128',1,1000,fetcher as unknown as typeof fetch);
    await (await client.request('/v1/models',{method:'GET'})).text();
    if(!seen)throw new Error('expected captured headers');
    expect((seen as Headers).has('authorization')).toBe(false);
  });
  it('refuses absolute and protocol-relative targets before attaching the credential',async()=>{
    const fetcher=vi.fn(async()=>new Response('{}'));
    const client=new OmniRouteClient('http://127.0.0.1:20128',1,1000,fetcher as unknown as typeof fetch,'s'.repeat(32));
    await expect(client.request('https://example.com/v1/models',{method:'GET'})).rejects.toThrow('upstream_target_outside_base');
    await expect(client.request('//example.com/v1/models',{method:'GET'})).rejects.toThrow('upstream_target_outside_base');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not append the credential to propagated fetch errors',async()=>{
    const credential='s'.repeat(32);
    const fetcher=vi.fn().mockRejectedValue(new Error('network'));
    const client=new OmniRouteClient('http://127.0.0.1:20128',1,1000,fetcher as unknown as typeof fetch,credential);
    let thrown: unknown;
    try {
      await client.request('/v1/models',{method:'GET'});
    } catch (error) {
      thrown=error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain('network');
    expect(String(thrown)).not.toContain(credential);
  });
});
