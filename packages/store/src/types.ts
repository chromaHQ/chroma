import { StateCreator, StoreApi } from 'zustand';

export type PersistOptions = {
  name: string;
  version?: number;
  migrate?: (state: any, version: number) => any;
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
