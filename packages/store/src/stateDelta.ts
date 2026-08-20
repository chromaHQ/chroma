/**
 * Delta encoding for state broadcasts.
 *
 * The service worker owns the state and every context that mirrors it needs to
 * be told when it changes. Sending the whole state each time makes the cost of a
 * broadcast proportional to total state size rather than to what changed, which
 * is the wrong shape: a one-field write on a large store pays for the whole
 * store, on every write, in every listening context.
 *
 * A delta carries only the top-level keys whose values changed identity. The
 * receiver merges it and applies structural sharing, so untouched branches keep
 * their references.
 */

/** Marks a broadcast payload as a delta rather than a whole state object. */
export const STATE_DELTA_MARKER = '__chromaStateDelta';

export interface StateDelta<T> {
  readonly [STATE_DELTA_MARKER]: true;
  /** Top-level keys whose values changed, with their new values. */
  changed: Partial<T>;
  /** Top-level keys that no longer exist on the state. */
  removed?: string[];
  /**
   * Monotonic counter. A receiver that has never applied a delta, or that has
   * missed one, can ask for the full state instead of merging blindly.
   */
  sequence: number;
}

/** Type guard for a delta payload arriving over the bridge. */
export function isStateDelta<T>(payload: unknown): payload is StateDelta<T> {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as Record<string, unknown>)[STATE_DELTA_MARKER] === true
  );
}

/**
 * Computes the top-level difference between two states.
 *
 * Comparison is by identity, matching how immutable state updates work: a slice
 * that was not written keeps its reference and is left out of the delta.
 *
 * @param previous - The last state the receiver is known to hold.
 * @param next - The current state.
 * @param sequence - Broadcast counter to stamp onto the delta.
 * @returns The delta, or `null` when nothing changed and no broadcast is needed.
 */
export function createStateDelta<T extends Record<string, unknown>>(
  previous: T | null,
  next: T,
  sequence: number,
): StateDelta<T> | null {
  if (previous === null) {
    return { [STATE_DELTA_MARKER]: true, changed: { ...next }, sequence };
  }

  const changed: Partial<T> = {};
  let changedCount = 0;

  for (const key of Object.keys(next) as (keyof T)[]) {
    if (!Object.is(previous[key], next[key])) {
      changed[key] = next[key];
      changedCount += 1;
    }
  }

  const removed = Object.keys(previous).filter((key) => !(key in next));

  if (changedCount === 0 && removed.length === 0) {
    return null;
  }

  return {
    [STATE_DELTA_MARKER]: true,
    changed,
    ...(removed.length > 0 ? { removed } : {}),
    sequence,
  };
}

/**
 * Merges a delta into a state object.
 *
 * @param current - The state the receiver currently holds.
 * @param delta - The delta to apply.
 * @returns A new state object, or `current` unchanged when the delta is a no-op.
 */
export function applyStateDelta<T extends Record<string, unknown>>(
  current: T,
  delta: StateDelta<T>,
): T {
  const changedKeys = Object.keys(delta.changed);
  const removedKeys = delta.removed ?? [];

  if (changedKeys.length === 0 && removedKeys.length === 0) {
    return current;
  }

  const merged = { ...current, ...delta.changed } as T;

  for (const key of removedKeys) {
    delete (merged as Record<string, unknown>)[key];
  }

  return merged;
}
