/**
 * Storage keys and the migration protocol between the two layouts.
 *
 * State can live as a single blob under the store name, or as one key per
 * top-level slice. The slice layout makes a write proportional to what changed
 * instead of to the size of the store, which matters when the store is large
 * and written often.
 *
 * Moving between them is the dangerous part, because for a moment both copies
 * exist. The rules below exist because breaking any of them has already cost a
 * real install its data:
 *
 * 1. A layout marker names which copy is authoritative. Without it, "which one
 *    wins" is a heuristic, and a heuristic that guesses wrong reads stale data
 *    or overwrites good data.
 * 2. Nothing is deleted until its replacement has been written AND read back.
 * 3. `chrome.runtime.lastError` is honoured on every write. A write that
 *    reported success but did not land is what turns step 2 into data loss.
 * 4. Migration does not start unless both copies fit under the quota. The
 *    doubling window is exactly where a large store runs out of room.
 */

const SEPARATOR = '::';

/** Names which copy is authoritative. Absent means the blob is. */
export function layoutKey(name: string): string {
  return `${name}${SEPARATOR}__layout`;
}

/** Lists the slices the slice layout holds. */
export function indexKey(name: string): string {
  return `${name}${SEPARATOR}__index`;
}

/** Counts failed migration attempts so a hopeless one stops retrying. */
export function attemptsKey(name: string): string {
  return `${name}${SEPARATOR}__migrationAttempts`;
}

/**
 * Holds a short history of what persistence did.
 *
 * The service worker is ephemeral and production builds strip `console`, so an
 * in-memory diagnostic is unreadable by the time anyone looks. This survives
 * both, and answers "did the migration run, and if not why" with one read.
 */
export function statusKey(name: string): string {
  return `${name}${SEPARATOR}__status`;
}

/** How many events the status record keeps. */
export const STATUS_HISTORY = 8;

export function sliceKey(name: string, slice: string): string {
  return `${name}${SEPARATOR}${slice}`;
}

/** Value written to {@link layoutKey} once the slice layout is authoritative. */
export const SLICE_LAYOUT = 'slices';

/** Give up on migrating after this many failures, and keep using the blob. */
export const MAX_MIGRATION_ATTEMPTS = 3;

/**
 * Fraction of the quota the two copies must fit inside before migrating.
 *
 * Leaves room for the state to grow between the check and the write, and for
 * whatever else the extension keeps in local storage.
 */
export const QUOTA_HEADROOM = 0.8;

/** Rough serialized size of a value, for the headroom check. */
export function approximateBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Whether writing a second copy of `snapshot` fits under the quota.
 *
 * @param bytesInUse - What local storage currently holds.
 * @param quotaBytes - The cap, or `0` when the runtime does not report one.
 * @param snapshot - The state about to be written a second time.
 */
export function hasHeadroomForMigration(
  bytesInUse: number,
  quotaBytes: number,
  snapshot: unknown,
): boolean {
  // No reported quota means no cliff to fall off.
  if (!quotaBytes) return true;

  return bytesInUse + approximateBytes(snapshot) <= quotaBytes * QUOTA_HEADROOM;
}
