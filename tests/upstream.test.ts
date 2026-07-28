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
