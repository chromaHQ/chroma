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
