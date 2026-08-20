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
      return nextArray.map((item, index) => replaceEqualDeep(previousArray[index], item)) as T;
    }

    let changed = false;
    const merged = nextArray.map((item, index) => {
      const mergedItem = replaceEqualDeep(previousArray[index], item);
      if (mergedItem !== previousArray[index]) changed = true;
      return mergedItem;
    });

    return (changed ? merged : previous) as T;
  }

  if (isPlainObject(previous) && isPlainObject(next)) {
    const previousKeys = Object.keys(previous);
    const nextKeys = Object.keys(next);

    let changed = previousKeys.length !== nextKeys.length;
    const merged: Record<string, unknown> = {};

    for (const key of nextKeys) {
      const mergedValue = replaceEqualDeep(previous[key], next[key]);
      if (mergedValue !== previous[key]) changed = true;
      merged[key] = mergedValue;
    }

    return (changed ? merged : previous) as T;
  }

  return next;
}
