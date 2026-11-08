/**
 * Coalescing writer for the project autosave.
 *
 * Every operation used to validate and copy the whole project into IndexedDB, so drawing with a large model open did that work once
 * per line. This writer keeps the same guarantees (writes happen in order, a caller that awaits `schedule` resumes only after a
 * write that contains its value or a newer one has finished, failures reach the callers they affect) but never queues more than one
 * write behind the one in flight: a burst of changes becomes the first write and one trailing write of the newest value.
 */
export interface LatestWinsWriter<T> {
  /** Resolves when `value`, or a value scheduled after it, has been written. Rejects when that write fails. */
  schedule(value: T): Promise<void>;
  /** Number of writes started so far (for tests and diagnostics). */
  readonly writes: () => number;
}

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

export function createLatestWinsWriter<T>(write: (value: T) => Promise<void>, minGapMs = 200): LatestWinsWriter<T> {
  let running = false;
  let started = 0;
  let pending: { value: T; waiters: Waiter[] } | undefined;

  const drain = async (first: { value: T; waiters: Waiter[] }): Promise<void> => {
    running = true;
    let batch: { value: T; waiters: Waiter[] } | undefined = first;
    while (batch !== undefined) {
      started += 1;
      try {
        await write(batch.value);
        for (const waiter of batch.waiters) waiter.resolve();
      } catch (error) {
        for (const waiter of batch.waiters) waiter.reject(error);
      }
      if (pending === undefined) break;
      // Let a burst of edits settle so they land in one write.
      if (minGapMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, minGapMs));
      batch = pending;
      pending = undefined;
    }
    running = false;
  };

  return {
    schedule(value: T): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const waiter: Waiter = { resolve, reject };
        if (!running) {
          void drain({ value, waiters: [waiter] });
          return;
        }
        if (pending === undefined) pending = { value, waiters: [waiter] };
        else pending = { value, waiters: [...pending.waiters, waiter] };
      });
    },
    writes: () => started
  };
}
