type StreamCloser = () => void;

/** Active hijacked streams are owned by the database they may still mutate. */
const activeByOwner = new WeakMap<object, Set<StreamCloser>>();

export function registerActiveStream(owner: object, close: StreamCloser): () => void {
  let active = activeByOwner.get(owner);
  if (!active) {
    active = new Set();
    activeByOwner.set(owner, active);
  }
  active.add(close);
  return () => {
    active?.delete(close);
    if (active?.size === 0) activeByOwner.delete(owner);
  };
}

/** Must run before the owning database is closed. Closers are idempotent. */
export function closeActiveStreams(owner: object): void {
  const active = activeByOwner.get(owner);
  if (!active) return;
  for (const close of [...active]) close();
  activeByOwner.delete(owner);
}
