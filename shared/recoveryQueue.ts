/** Closing must include changes that arrive while a checkpoint is in flight. */
export async function flushStableRecovery<T>(read: () => T, write: (snapshot: T) => Promise<unknown>) {
  let snapshot: T;
  do {
    snapshot = read();
    await write(snapshot);
  } while (read() !== snapshot);
}

/** Serialize acknowledgements so an older checkpoint cannot replace a newer one. */
export function createRecoveryQueue<T>(write: (payload: T) => Promise<number>) {
  let tail: Promise<unknown> = Promise.resolve();
  let generation = 0;
  return {
    // An edit can precede its debounced write; older receipts are then stale.
    invalidate() { generation += 1; },
    save(payload: T): Promise<{ savedAt: number; current: boolean }> {
      const requested = ++generation;
      const result = tail.catch(() => undefined).then(() => write(payload));
      tail = result;
      return result.then((savedAt) => ({ savedAt, current: generation === requested }));
    },
  };
}
