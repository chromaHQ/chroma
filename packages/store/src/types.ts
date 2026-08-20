import { StateCreator, StoreApi } from 'zustand';

export type PersistOptions = {
  name: string;
  version?: number;
  migrate?: (state: any, version: number) => any;
  /**
   * Narrows what gets written to `chrome.storage.local`.
   *
   * Persistence writes the whole state by default, so anything large and
   * refetchable — cached catalogs, derived views, in-flight request bookkeeping —
   * is re-serialized on every change and counts against the extension's storage
   * quota. Return only what must survive a restart.
   *
   * @example
   * ```ts
   * withPersistence({
   *   name: 'app',
   *   partialize: ({ subnets, priceCache, ...persisted }) => persisted,
   * });
   * ```
   */
  partialize?: (state: any) => any;
  /**
   * Called as persistence reports what it did.
   *
   * The same events are recorded durably in storage; this hook exists so an app
   * can route them somewhere it already watches, such as its own logger or an
   * error reporter. Must not throw.
   */
  onEvent?: (event: import('./persistenceEvents.js').PersistenceEvent) => void;
};

export interface StoreDefinition {
  name: string;
  slices?: StateCreator<any, [], [], any>[];
  persistence?: PersistOptions;
  config?: Record<string, any>;
}

// Extract the return type from a StateCreator
export type ExtractSliceState<T> =
  T extends StateCreator<infer State, any, any, any> ? State : never;

// Improved slice creator type that works better with inference
export type SliceCreator<T> = StateCreator<T, [], [], T>;

// Better type for slice configs that preserves literal types
export interface StoreConfig<T> {
  slices: readonly StateCreator<any, [], [], any>[];
  persist?: PersistOptions;
}

// Improved merge utility that works with actual slice return types
export type MergeSlices<Slices extends readonly StateCreator<any, [], [], any>[]> =
  Slices extends readonly [infer First, ...infer Rest]
    ? First extends StateCreator<any, [], [], infer FirstState>
      ? Rest extends readonly StateCreator<any, [], [], any>[]
        ? FirstState & MergeSlices<Rest>
        : FirstState
      : {}
    : {};

export interface CentralStore<T> extends StoreApi<T> {
  isReady: () => boolean;
  onReady: (callback: () => void) => () => void;
  reset: () => void;
}
