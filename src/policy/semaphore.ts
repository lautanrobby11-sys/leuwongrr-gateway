export class BoundedSemaphore {
  private active = 0;
  constructor(private readonly limit: number) {}
  get inUse() { return this.active; }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) throw new OverloadError();
    this.active += 1;
    try { return await operation(); } finally { this.active -= 1; }
  }
}
export class OverloadError extends Error { constructor() { super('upstream_concurrency_exhausted'); } }
