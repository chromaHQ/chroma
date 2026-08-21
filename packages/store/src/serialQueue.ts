/**
 * Runs async tasks one at a time, in the order they were submitted.
 *
 * Persistence works out what to write by comparing against a record of what was
 * last stored, then advances that record. Two writes in flight together would
 * both compare against the same record and both move it, leaving what it claims
 * and what storage holds free to disagree — after which a later change that
 * looks identical to the record is skipped and never reaches disk.
 *
 * Ordering between overlapping `chrome.storage.local.set` calls is not
 * something to assume, so the sequencing is made explicit.
 */
export interface SerialQueue {
  /**
   * Queues a task behind everything already submitted.
   *
   * @returns A promise for this task's turn completing. A task that rejects is
   *   reported to `onError` and does not stall the queue.
   */
  run: (task: () => Promise<void>) => Promise<void>;
  /** Resolves when everything submitted so far has finished. */
  drain: () => Promise<void>;
}

/**
 * @param onError - Receives a task's failure. The queue continues either way,
 *   because one failed write must not stop every write after it.
 */
export function createSerialQueue(onError?: (error: unknown) => void): SerialQueue {
  let tail: Promise<void> = Promise.resolve();

  const run = (task: () => Promise<void>): Promise<void> => {
    const next = tail.then(task).catch((error) => {
      try {
        onError?.(error);
      } catch {
        /* A reporter must not be able to break the queue either. */
      }
    });

    tail = next;
    return next;
  };

  return { run, drain: () => tail };
}
