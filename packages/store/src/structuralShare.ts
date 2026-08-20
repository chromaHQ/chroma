/**
 * Structural sharing for state that arrives over the extension bridge.
 *
 * A bridge store receives state as a freshly deserialized object graph, so every
 * value has a new identity even when nothing about it changed. Selectors compare
 * with `Object.is`, so without structural sharing a single unrelated write
 * re-renders every component that reads any part of the state.
 *
 * `replaceEqualDeep` walks the incoming value against the one already held and
 * reuses the previous reference for every subtree that is deeply equal. Only
 * branches that genuinely changed get new identities.
 */

const objectPrototype = Object.prototype;

/**
 * Whether a value is a plain object, as opposed to a class instance, a `Map`,
 * an array, or a null-prototype bag we should not walk into.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;

  const prototype = Object.getPrototypeOf(value);
  return prototype === objectPrototype || prototype === null;
}

function isSameSet(a: Set<unknown>, b: Set<unknown>): boolean {
  if (a.size !== b.size) return false;

  for (const value of b) {
    if (!a.has(value)) return false;
  }

  return true;
}

/**
 * Reuses `previous` wherever it is deeply equal to `next`.
 *
 * @param previous - The value currently held by the store.
 * @param next - The value that just arrived.
 * @returns `previous` when the two are deeply equal, otherwise a value shaped
 *   like `next` whose unchanged subtrees still point at `previous`.
 *
 * @example
 * ```ts
 * const held = { wallets: { a: 1 }, subnets: { 1: { price: 1 } } };
 * const incoming = { wallets: { a: 1 }, subnets: { 1: { price: 2 } } };
 * const merged = replaceEqualDeep(held, incoming);
 *
 * merged.wallets === held.wallets;  // true  — selectors do not re-render
 * merged.subnets === held.subnets;  // false — this one really changed
 * ```
 */
export function replaceEqualDeep<T>(previous: unknown, next: T): T {
  if (Object.is(previous, next)) {
    return previous as T;
  }

  if (previous instanceof Date && next instanceof Date) {
    return (previous.getTime() === next.getTime() ? previous : next) as T;
  }

  if (previous instanceof Set && next instanceof Set) {
    return (isSameSet(previous, next) ? previous : next) as T;
  }

  if (previous instanceof Map && next instanceof Map) {
    if (previous.size !== next.size) return next;

    let changed = false;
    const merged = new Map<unknown, unknown>();

    for (const [key, value] of next) {
      if (!previous.has(key)) return next;

      const mergedValue = replaceEqualDeep(previous.get(key), value);
      if (mergedValue !== previous.get(key)) changed = true;
      merged.set(key, mergedValue);
    }

    return (changed ? merged : previous) as T;
  }

  const previousIsArray = Array.isArray(previous);
  const nextIsArray = Array.isArray(next);

  if (previousIsArray && nextIsArray) {
    const previousArray = previous as unknown[];
    const nextArray = next as unknown[];

    if (previousArray.length !== nextArray.length) {
      // Length changed, but individual elements may still be reusable.
      const resized = new Array(nextArray.length);
      for (let index = 0; index < nextArray.length; index += 1) {
        resized[index] = replaceEqualDeep(previousArray[index], nextArray[index]);
      }
      return resized as T;
    }

    // Nothing is allocated until an element actually differs. On a large state
    // most subtrees are unchanged, and eagerly building a copy of each one only
    // to discard it dominates the cost of the walk.
    let merged: unknown[] | null = null;

    for (let index = 0; index < nextArray.length; index += 1) {
      const value = replaceEqualDeep(previousArray[index], nextArray[index]);

      if (merged === null) {
        if (value !== previousArray[index]) {
          // First divergence: everything before it was reusable as-is.
          merged = previousArray.slice(0, index);
          merged.push(value);
        }
        continue;
      }

      merged.push(value);
    }

    return (merged ?? previousArray) as T;
  }

  if (isPlainObject(previous) && isPlainObject(next)) {
    const nextKeys = Object.keys(next);
    const shapeChanged = Object.keys(previous).length !== nextKeys.length;

    // A changed shape always needs a new object, so fill one from the start.
    let merged: Record<string, unknown> | null = shapeChanged ? {} : null;

    for (let index = 0; index < nextKeys.length; index += 1) {
      const key = nextKeys[index];
      const value = replaceEqualDeep(previous[key], next[key]);

      if (merged === null) {
        // The `in` check only runs for undefined values, where identity alone
        // cannot tell "absent" from "present and undefined".
        const diverged = value !== previous[key] || (value === undefined && !(key in previous));

        if (diverged) {
          merged = {};
          for (let earlier = 0; earlier < index; earlier += 1) {
            merged[nextKeys[earlier]] = previous[nextKeys[earlier]];
          }
          merged[key] = value;
        }
        continue;
      }

      merged[key] = value;
    }

    return (merged ?? previous) as T;
  }

  return next;
}
