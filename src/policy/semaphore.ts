export class BoundedSemaphore {
  private active = 0;
  constructor(private readonly limit: number) {}
  get inUse() { return this.active; }
  acquire(): () => void {
    if (this.active >= this.limit) throw new OverloadError();
    this.active += 1;
    let released=false;
    return () => { if (!released) { released=true; this.active-=1; } };
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release=this.acquire();
    try { return await operation(); } finally { release(); }
  }
}
export class OverloadError extends Error { constructor() { super('upstream_concurrency_exhausted'); } }
