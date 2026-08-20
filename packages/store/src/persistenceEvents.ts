/**
 * What persistence reports about itself.
 *
 * These are the questions worth being able to answer after the fact on a real
 * install: which layout is in use, whether the migration ran, and if it did not,
 * precisely what stopped it.
 */

export type PersistenceEvent =
  /** State was read at startup. `source` is which copy it came from. */
  | { type: 'loaded'; source: 'blob' | 'slices' | 'none' }
  /** Migration did not start. The store stays correct on the blob. */
  | {
      type: 'migration-skipped';
      reason: 'no-headroom' | 'too-many-attempts';
      bytesInUse: number;
      quotaBytes: number;
    }
  /** Migration started and backed out. The blob is still authoritative. */
  | { type: 'migration-aborted'; reason: string; attempt: number }
  /** Migration completed and the blob was removed. */
  | { type: 'migrated'; slices: number; durationMs: number }
  /** The slice layout was incomplete. `recovered` is what was used instead. */
  | { type: 'layout-torn'; missing: string[]; recovered: 'blob' | 'none' }
  /** Reads failed, so this session will not write. */
  | { type: 'writes-disabled'; reason: string }
  /** A write did not land. The baseline was not advanced, so it will retry. */
  | { type: 'write-failed'; reason: string };

/** One entry in the durable status record. */
export interface PersistenceStatusEntry {
  /** Epoch milliseconds. */
  at: number;
  event: PersistenceEvent;
}

export interface PersistenceStatus {
  /** Which layout the last session used. */
  layout: 'blob' | 'slices';
  /** Most recent first. */
  history: PersistenceStatusEntry[];
}
