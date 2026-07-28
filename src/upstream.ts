import { BoundedSemaphore } from './policy/semaphore.js';

export class OmniRouteClient {
  private readonly semaphore: BoundedSemaphore;
  constructor(private readonly baseUrl:string, concurrency:number, private readonly timeoutMs:number, private readonly fetcher:typeof fetch = fetch) { this.semaphore = new BoundedSemaphore(concurrency); }
  request(path:string, init:RequestInit, clientSignal?:AbortSignal): Promise<Response> {
    return this.semaphore.run(async () => {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = clientSignal ? AbortSignal.any([clientSignal,timeout]) : timeout;
      const response = await this.fetcher(new URL(path,this.baseUrl), { ...init, signal, redirect:'error' });
      return response;
    });
  }
}
