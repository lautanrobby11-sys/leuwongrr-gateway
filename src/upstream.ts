import { BoundedSemaphore } from './policy/semaphore.js';

export class OmniRouteClient {
  private readonly semaphore: BoundedSemaphore;
  constructor(private readonly baseUrl:string, concurrency:number, private readonly timeoutMs:number, private readonly fetcher:typeof fetch = fetch, private readonly apiKey?:string) { this.semaphore = new BoundedSemaphore(concurrency); }
  /**
   * OmniRoute answers /v1/* with 401 AUTH_002 while REQUIRE_API_KEY is true, so
   * the upstream credential is attached to every call, streaming included. Its
   * value is never logged and never echoed back to a gateway client.
   */
  private authenticate(init:RequestInit): RequestInit {
    if(!this.apiKey) return init;
    const headers=new Headers(init.headers);
    headers.set('authorization',`Bearer ${this.apiKey}`);
    return {...init,headers};
  }
  private target(path:string): URL {
    if(!path.startsWith('/') || path.startsWith('//')) throw new Error('upstream_target_outside_base');
    const base=new URL(this.baseUrl);
    const target=new URL(path,base);
    if(target.origin!==base.origin) throw new Error('upstream_target_outside_base');
    return target;
  }
  async request(path:string, init:RequestInit, clientSignal?:AbortSignal): Promise<Response> {
    const target=this.target(path);
    const release=this.semaphore.acquire();
    try {
      const timeout=AbortSignal.timeout(this.timeoutMs);
      const signal=clientSignal?AbortSignal.any([clientSignal,timeout]):timeout;
      const response=await this.fetcher(target,{...this.authenticate(init),signal,redirect:'error'});
      if(!response.body){ release(); return response; }
      const reader=response.body.getReader();
      const body=new ReadableStream<Uint8Array>({
        async pull(controller){
          try { const chunk=await reader.read(); if(chunk.done){release();controller.close();} else controller.enqueue(chunk.value); }
          catch(error){release();controller.error(error);}
        },
        async cancel(reason){ try { await reader.cancel(reason); } finally { release(); } }
      });
      return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
    } catch(error){ release(); throw error; }
  }
}
