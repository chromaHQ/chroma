import { createStore as createZustandStore, StateCreator } from 'zustand/vanilla';
import { chromeStoragePersist } from './persist.js';
import { createBridgeStore, type BridgeWithEvents } from './bridge.js';
import type { CentralStore, PersistOptions } from './types.js';

interface StoreConfig {
  name: string;
  slices: StateCreator<any, [], [], any>[];
  bridge?: BridgeWithEvents;
  persistence?: PersistOptions;
}

const readyCallbacks = new Set<() => void>();

/**
 * Core store builder with fluent API
 */
export class StoreBuilder<T = any> {
  private config: StoreConfig;
  private onReadyCallbacks = new Set<() => void>();

  constructor(name: string = 'default') {
    this.config = {
      name,
      slices: [],
    };
  }

  /**
   * Add state slices to the store
   */
  withSlices(...slices: StateCreator<any, [], [], any>[]): this {
    this.config.slices = [...this.config.slices, ...slices];
    return this;
  }

  onReady(callback: () => void): this {
    this.onReadyCallbacks.add(callback);
    return this;
  }

  /**
   * Attach a bridge for cross-context communication
   */
  withBridge(bridge?: BridgeWithEvents): this {
    this.config.bridge = bridge;
    return this;
  }

  /**
   * Enable persistence with Chrome storage
   */
  withPersistence(options?: PersistOptions): this {
    this.config.persistence = options;
    return this;
  }

  /**
   * Create the store
   */
  async create(): Promise<CentralStore<T>> {
    if (this.config.slices.length === 0) {
      throw new Error('Store must have at least one slice. Use withSlices() to add state.');
    }

    return await this.createBaseStore();
  }

  private async createBaseStore(): Promise<CentralStore<T>> {
    const bridge = this.config.bridge;

    if (bridge) {
      return createBridgeStore<T>(bridge, undefined, this.config.name, this.onReadyCallbacks);
    }

    return this.createServiceWorkerStore();
  }

  private createServiceWorkerStore(): CentralStore<T> {
    let isReady = false;
    let initialState: T | null = null;
    let runtimeBridge: any;

    const notifyReady = () => {
      isReady = true;
      readyCallbacks.forEach((callback) => callback());
      this.onReadyCallbacks.forEach((callback) => callback());
      readyCallbacks.clear();
      this.onReadyCallbacks.clear();
    };

    const creator: StateCreator<T> = (set, get, store) => {
      let state = {} as T;

      for (const slice of this.config.slices) {
        const sliceState = slice(set, get, store);
        state = { ...state, ...sliceState };
      }

      // Store initial state for reset functionality
      if (initialState === null) {
        initialState = { ...state };
      }

      return state;
    };

    const persistOptions = {
      name: this.config.name,
      onReady: notifyReady,
    };

    const persistedCreator = chromeStoragePersist<T>(persistOptions)(creator);

    const store = createZustandStore<T>(persistedCreator);

    store.subscribe(() => {
      if (runtimeBridge) {
        console.log(runtimeBridge);
        runtimeBridge.broadcast(`store:${this.config.name}:stateChanged`, store.getState());
      }
    });

    // Extend the store with ready functionality
    const centralStore = Object.assign(store, {
      isReady: () => isReady,
      reset: () => {
        if (initialState !== null) {
          store.setState(initialState, true); // replace entire state
        } else {
          console.warn('ServiceWorkerStore: Cannot reset, initial state not available');
        }
      },
      setBridge: (bridge: any) => {
        runtimeBridge = bridge;
      },
      onReady: (callback: () => void) => {
        if (isReady) {
          callback();
        } else {
          readyCallbacks.add(callback);
        }
        return () => {
          readyCallbacks.delete(callback);
        };
      },
    }) as CentralStore<T>;

    return centralStore;
  }
}

/**
 * Create a new store builder
 */
export function createStore<T = any>(name?: string): StoreBuilder<T> {
  return new StoreBuilder<T>(name);
}

/**
 * Create a service worker store directly (convenience function)
 * This creates a store optimized for service worker context with persistence
 */
export function createServiceWorkerStore<T = any>(
  slices: StateCreator<T, [], [], T>[] | StateCreator<T, [], [], T>,
  name: string = 'default',
  persistOptions?: PersistOptions,
): Promise<CentralStore<T>> {
  const sliceArray = Array.isArray(slices) ? slices : [slices];

  let builder = createStore<T>(name).withSlices(...sliceArray);

  if (persistOptions) {
    builder = builder.withPersistence(persistOptions);
  }

  return builder.create();
}

/**
 * Create a bridge store directly (convenience function)
 * This creates a store optimized for UI context that connects to service worker
 */
export function createUIStore<T = any>(
  bridge: BridgeWithEvents,
  initialState?: T,
  name: string = 'default',
): CentralStore<T> {
  return createBridgeStore<T>(bridge, initialState, name);
}
