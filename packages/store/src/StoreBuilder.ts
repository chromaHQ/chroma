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

/**
 * Core store builder with fluent API
 */
export class StoreBuilder<T = any> {
  private config: StoreConfig;

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

  /**
   * Attach a bridge for cross-context communication
   */
  withBridge(bridge?: BridgeWithEvents): this {
    this.config.bridge = bridge;
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
    const bridge = this.config.bridge || (globalThis as any).bridge;

    if (bridge) {
      console.log('Creating bridge store', this.config.name);
      createBridgeStore<T>(bridge, undefined, this.config.name);
    }

    console.log('Creating service worker store', this.config.name);
    return this.createServiceWorkerStore();
  }

  private createServiceWorkerStore(): CentralStore<T> {
    const creator: StateCreator<T> = (set, get, store) => {
      let state = {} as T;

      for (const slice of this.config.slices) {
        const sliceState = slice(set, get, store);
        state = { ...state, ...sliceState };
      }

      return state;
    };

    // All stores are automatically persistent
    const persistOptions = { name: this.config.name };
    const persistedCreator = chromeStoragePersist<T>(persistOptions)(creator);

    const store = createZustandStore<T>(persistedCreator);
    const centralStore = store as CentralStore<T>;

    return centralStore;
  }
}

/**
 * Create a new store builder
 */
export function createStore<T = any>(name?: string): StoreBuilder<T> {
  return new StoreBuilder<T>(name);
}
