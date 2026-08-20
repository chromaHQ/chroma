import { useRef, useSyncExternalStore } from 'react';
import type { CentralStore } from './types.js';

/**
 * Subscribes a component to a slice of a central store.
 *
 * The default comparison is `Object.is`, which is meaningful because both store
 * implementations preserve references for slices that did not change: the
 * service worker store updates immutably, and the bridge store applies
 * structural sharing to incoming state. A component therefore re-renders only
 * when the slice it selected actually changed.
 *
 * @param store - The store to read from.
 * @param selector - Reads the slice this component cares about. Keep it cheap;
 *   it runs on every store change.
 * @param equalityFn - Optional comparison, needed only when the selector builds
 *   a new value rather than returning one held in state. Pass {@link shallow}
 *   for the common object/array case.
 *
 * @example
 * ```ts
 * // Stable reference from state — no equality function needed.
 * const wallets = useCentralStore(store, (s) => s.wallets);
 *
 * // Derived object — compare by value or it re-renders on every change.
 * const summary = useCentralStore(store, (s) => ({ id: s.id, name: s.name }), shallow);
 * ```
 */
export function useCentralStore<T, U = T>(
  store: CentralStore<T>,
  selector: (state: T) => U,
  equalityFn?: (a: U, b: U) => boolean,
): U {
  // Held in a ref rather than a memo so the cached selection survives renders
  // even when `selector` is an inline arrow with a new identity each time.
  const memo = useRef<{ hasValue: boolean; value: U }>({
    hasValue: false,
    value: undefined as unknown as U,
  });

  const getSnapshot = () => {
    const next = selector(store.getState());

    if (equalityFn && memo.current.hasValue && equalityFn(memo.current.value, next)) {
      return memo.current.value;
    }

    memo.current.hasValue = true;
    memo.current.value = next;
    return next;
  };

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

export function useCentralDispatch<T>(store: CentralStore<T>) {
  return store.setState;
}

/**
 * React hook to check if the store is ready (fully loaded from persistence/bridge)
 */
export function useStoreReady<T>(store: CentralStore<T>): boolean {
  return useSyncExternalStore(
    store.onReady,
    store.isReady,
    () => false, // Server-side fallback
  );
}

/**
 * React hook to get the reset function for a store
 */
export function useStoreReset<T>(store: CentralStore<T>): () => void {
  return store.reset;
}
