/**
 * Topic naming for scoped state broadcasts.
 *
 * A UI context registers the slices it reads; the service worker then builds a
 * per-port payload containing only those. Names are namespaced by store so two
 * stores sharing a port cannot be mistaken for one another.
 */

/**
 * Marks a port as participating in scoped delivery for one store.
 *
 * Its absence means "send me everything", which is what a context that has not
 * opted in — or is running an older build — should keep getting.
 */
export function scopeMarkerTopic(storeName: string): string {
  return `store:${storeName}:__scoped__`;
}

/** Topic for one top-level state key. */
export function sliceTopic(storeName: string, slice: string): string {
  return `store:${storeName}:slice:${slice}`;
}

/**
 * Narrows a delta to the slices a port asked for.
 *
 * The result always carries the original sequence number, even when nothing
 * relevant changed: a receiver treats a gap in the sequence as a missed
 * broadcast and resynchronizes, so skipping the message would cost far more
 * than sending an empty one.
 */
export function filterDeltaToTopics<T>(
  delta: { changed: Partial<T>; removed?: string[]; sequence: number },
  storeName: string,
  topics: ReadonlySet<string>,
): { changed: Partial<T>; removed?: string[]; sequence: number } {
  const changed: Partial<T> = {};

  for (const key of Object.keys(delta.changed) as (keyof T & string)[]) {
    if (topics.has(sliceTopic(storeName, key))) {
      changed[key] = delta.changed[key];
    }
  }

  const removed = delta.removed?.filter((key) => topics.has(sliceTopic(storeName, key)));

  return {
    changed,
    ...(removed && removed.length > 0 ? { removed } : {}),
    sequence: delta.sequence,
  };
}
