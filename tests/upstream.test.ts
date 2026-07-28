import { describe,expect,it,vi } from 'vitest';
import { OmniRouteClient } from '../src/upstream.js';
import { OverloadError } from '../src/policy/semaphore.js';

describe('upstream resource envelope',()=>{
  it('holds the permit until response body consumption completes',async()=>{let controller!:ReadableStreamDefaultController<Uint8Array>;const fetcher=vi.fn(async()=>new Response(new ReadableStream<Uint8Array>({start(c){controller=c;}})));const client=new OmniRouteClient('http://127.0.0.1:20128',1,1000,fetcher as typeof fetch);const first=await client.request('/v1/chat/completions',{});await expect(client.request('/v1/chat/completions',{})).rejects.toBeInstanceOf(OverloadError);controller.close();await first.text();const third=await client.request('/v1/chat/completions',{});controller.close();await third.text();expect(fetcher).toHaveBeenCalledTimes(2);});
  it('releases permit when fetch fails',async()=>{const fetcher=vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(new Response('{}'));const client=new OmniRouteClient('http://127.0.0.1:20128',1,1000,fetcher as typeof fetch);await expect(client.request('/x',{})).rejects.toThrow('network');await expect(client.request('/x',{})).resolves.toBeInstanceOf(Response);});
});
