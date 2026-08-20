/**
 * Shallow equality, for selectors that build a new object or array on each call.
 *
 * Structural sharing keeps identities stable for values read straight out of
 * state, so `Object.is` is enough for `useStore((s) => s.wallets)`. A selector
 * that *derives* a value — picking several fields into an object, mapping an
 * array — necessarily returns a new reference every time, and needs a
 * value-based comparison instead.
 */

/**
 * Compares two values one level deep.
 *
 * @example
 * ```ts
 * const { name, balance } = useStore((s) => ({ name: s.name, balance: s.balance }), shallow);
 * ```
 */
export function shallow<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;

  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false;
  }

  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, value] of a) {
      if (!b.has(key) || !Object.is(value, b.get(key))) return false;
    }
    return true;
  }

  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const value of a) {
      if (!b.has(value)) return false;
    }
    return true;
  }

  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }

  return true;
}
