type Timer<Handle> = { set: (run: () => void, delay: number) => Handle; clear: (handle: Handle) => void };

/** Coalesce work and invalidate already-queued callbacks when switching views. */
export function createDeferredTask<Handle>(run: () => void, delay: number, timer: Timer<Handle>) {
  let handle: Handle | undefined;
  let generation = 0;
  function cancel() {
    generation += 1;
    if (handle !== undefined) timer.clear(handle);
    handle = undefined;
  }
  return {
    schedule() {
      cancel();
      const requested = generation;
      handle = timer.set(() => {
        if (requested !== generation) return;
        handle = undefined;
        run();
      }, delay);
    },
    cancel,
    flush() { cancel(); run(); },
  };
}
