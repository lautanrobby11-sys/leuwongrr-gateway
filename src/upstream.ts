import { BoundedSemaphore } from './policy/semaphore.js';

export class OmniRouteClient {
  private readonly semaphore: BoundedSemaphore;
  constructor(private readonly baseUrl:string, concurrency:number, private readonly timeoutMs:number, private readonly fetcher:typeof fetch = fetch) { this.semaphore = new BoundedSemaphore(concurrency); }
  async request(path:string, init:RequestInit, clientSignal?:AbortSignal): Promise<Response> {
    const release=this.semaphore.acquire();
    try {
      const timeout=AbortSignal.timeout(this.timeoutMs);
      const signal=clientSignal?AbortSignal.any([clientSignal,timeout]):timeout;
      const response=await this.fetcher(new URL(path,this.baseUrl),{...init,signal,redirect:'error'});
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
