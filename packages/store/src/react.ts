import { useSyncExternalStore } from 'react';
import type { CentralStore } from './types.js';

export function useCentralStore<T, U = T>(store: CentralStore<T>, selector: (state: T) => U): U {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
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
