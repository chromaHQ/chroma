import { createStore as createZustandStore, StateCreator } from 'zustand/vanilla';
import { chromeStoragePersist } from './persist.js';
import { createBridgeStore, type BridgeWithEvents } from './bridge.js';
import { createStateDelta } from './stateDelta.js';
import { filterDeltaToTopics, scopeMarkerTopic } from './topics.js';
import type { CentralStore, PersistOptions } from './types.js';

interface StoreConfig {
  name: string;
  slices: StateCreator<any, [], [], any>[];
  bridge?: BridgeWithEvents;
  persistence?: PersistOptions;
}

/** The subset of the runtime bridge a service-worker store broadcasts through. */
interface BroadcastCapableBridge {
  broadcast: (key: string, payload: unknown) => void;
  broadcastScoped?: (
    key: string,
    buildPayload: (topics: ReadonlySet<string> | null) => unknown,
  ) => void;
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
    let runtimeBridge: BroadcastCapableBridge | undefined;

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
      ...this.config.persistence,
      // The storage key deliberately stays the store name rather than
      // `persistence.name`. Honouring the configured name now would orphan
      // state written by every earlier version, which for an extension means
      // users appearing to lose their data on upgrade.
      name: this.config.name,
      onReady: notifyReady,
    };

    const persistedCreator = chromeStoragePersist<T>(persistOptions)(creator);

    const store = createZustandStore<T>(persistedCreator);

    // Broadcasts are batched so a burst of writes reaches listening contexts as
    // one message instead of one per write.
    let broadcastDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let broadcastBatchStartedAt: number | null = null;
    const BROADCAST_DEBOUNCE_MS = 50; // 50ms batching window
    // A trailing debounce with no ceiling starves listeners while writes keep
    // arriving. Once a batch has waited this long it goes out regardless.
    const BROADCAST_MAX_WAIT_MS = 250;

    // The last state every listening context is known to have received. Deltas
    // are computed against it so a broadcast costs what changed, not what the
    // store happens to hold.
    let lastBroadcastState: Record<string, unknown> | null = null;
    let broadcastSequence = 0;

    const flushBroadcast = () => {
      broadcastDebounceTimer = null;
      broadcastBatchStartedAt = null;

      if (!runtimeBridge) return;

      const state = store.getState() as unknown as Record<string, unknown>;
      const delta = createStateDelta(lastBroadcastState, state, broadcastSequence);

      // Every changed slice was already coalesced into an earlier broadcast.
      if (delta === null) return;

      broadcastSequence += 1;
      lastBroadcastState = state;

      const key = `store:${this.config.name}:stateChanged`;

      // Older runtimes have no per-port delivery; everyone gets the full delta.
      if (typeof runtimeBridge.broadcastScoped !== 'function') {
        runtimeBridge.broadcast(key, delta);
        return;
      }

      const storeName = this.config.name;

      runtimeBridge.broadcastScoped(key, (topics: ReadonlySet<string> | null) => {
        if (!topics || !topics.has(scopeMarkerTopic(storeName))) {
          // This port never opted into scoping, so it still expects everything.
          return delta;
        }

        return filterDeltaToTopics(delta, storeName, topics);
      });
    };

    store.subscribe(() => {
      if (!runtimeBridge) return;

      const now = Date.now();
      if (broadcastBatchStartedAt === null) {
        broadcastBatchStartedAt = now;
      }

      const remainingMaxWait = Math.max(0, BROADCAST_MAX_WAIT_MS - (now - broadcastBatchStartedAt));

      if (broadcastDebounceTimer) {
        clearTimeout(broadcastDebounceTimer);
      }

      broadcastDebounceTimer = setTimeout(
        flushBroadcast,
        Math.min(BROADCAST_DEBOUNCE_MS, remainingMaxWait),
      );
    });

    // Extend the store with ready functionality
    const centralStore = Object.assign(store, {
      isReady: () => isReady,
      reset: () => {
        if (initialState !== null) {
          store.setState(initialState, true); // replace entire state
        }
      },
      setBridge: (bridge: BroadcastCapableBridge) => {
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
