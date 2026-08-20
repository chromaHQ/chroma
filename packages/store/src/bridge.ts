import type { CentralStore } from './types.js';
import { replaceEqualDeep } from './structuralShare.js';
import { applyStateDelta, isStateDelta, type StateDelta } from './stateDelta.js';
import { scopeMarkerTopic, sliceTopic } from './topics.js';

// Import bridge types from chroma core/react
export interface Bridge {
  send: <Req = unknown, Res = unknown>(
    key: string,
    payload?: Req,
    timeoutDuration?: number,
  ) => Promise<Res>;
  isConnected: boolean;
}

export interface BridgeWithEvents extends Bridge {
  on?: (key: string, handler: (payload: any) => void) => void;
  off?: (key: string, handler: (payload: any) => void) => void;
  /**
   * Declares which broadcast topics this context wants. Optional: a bridge
   * without it simply receives every broadcast, as before.
   */
  setTopics?: (topics: readonly string[]) => void;
}

export interface BridgeWithHandlers extends Bridge {
  register: (key: string, handler: (payload?: any) => any) => void;
  broadcast: (key: string, payload: any) => void;
  /**
   * Builds a payload per recipient from the topics that port registered.
   * Optional: falls back to `broadcast` when the runtime does not provide it.
   */
  broadcastScoped?: (
    key: string,
    buildPayload: (topics: ReadonlySet<string> | null) => any,
  ) => void;
  on?: (key: string, handler: (payload: any) => void) => void;
  off?: (key: string, handler: (payload: any) => void) => void;
}

// Bridge store that proxies all operations to the service worker
export class BridgeStore<T> implements CentralStore<T> {
  private bridge: BridgeWithEvents;
  private listeners = new Set<(state: T, prevState: T) => void>();
  private currentState: T | null = null;
  private previousState: T | null = null;
  private initialState: T | null = null;
  private storeName: string;
  private ready: boolean = false;
  private readyCallbacks = new Set<() => void>();
  private initializationAttempts: number = 0;
  private readonly maxInitializationAttempts: number = 10;
  private initializationTimer: ReturnType<typeof setTimeout> | null = null;
  private isInitializing: boolean = false;

  // Store handler references for cleanup (prevents memory leaks)
  private reconnectHandler: ((payload?: unknown) => void) | null = null;
  private disconnectHandler: ((payload?: unknown) => void) | null = null;
  private stateChangedHandler: ((payload?: unknown) => void) | null = null;

  // Debounce timer for state sync (optimization for rapid updates)
  private stateSyncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly stateSyncDebounceMs: number = 50; // Reduced to 50ms for faster reactivity

  // A trailing debounce alone can starve the UI: a store that is written to
  // more often than the debounce window would never flush. Once a batch has
  // been waiting this long it is applied regardless of further activity.
  private readonly stateSyncMaxWaitMs: number = 250;
  private stateSyncBatchStartedAt: number | null = null;

  // Deltas arriving during a debounce window are merged rather than dropped;
  // unlike a full-state payload, a later delta does not supersede an earlier one.
  private pendingDelta: StateDelta<T> | null = null;
  private pendingFullState: T | null = null;

  // Sequence of the next delta expected from the service worker. A gap means a
  // broadcast was missed, so the store refetches instead of merging blindly.
  private expectedDeltaSequence: number | null = null;

  // Top-level keys any selector in this context has actually read. The service
  // worker uses them to build a payload holding nothing this context ignores.
  private readonly trackedSlices = new Set<string>();
  private scopeSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly scopeSyncDebounceMs: number = 50;

  // One tracking proxy per state object, so repeated reads of the same state do
  // not allocate and `getState() === getState()` still holds.
  private trackedStateSource: T | null = null;
  private trackedStateProxy: T | null = null;

  // Reconnect delay timer (to allow SW to bootstrap before re-initializing)
  private reconnectDelayTimer: ReturnType<typeof setTimeout> | null = null;

  // Visibility change handling - refresh state when tab becomes visible
  private visibilityHandler: (() => void) | null = null;
  private lastVisibleAt: number = Date.now();
  private readonly staleThresholdMs: number = 30000; // Consider state stale after 30s hidden

  constructor(
    bridge: BridgeWithEvents,
    initialState?: T,
    storeName = 'default',
    readyCallbacks: Set<() => void> = new Set(),
  ) {
    this.bridge = bridge;
    this.currentState = initialState || null;
    this.previousState = initialState || null;
    this.initialState = initialState || null;
    this.storeName = storeName;
    this.readyCallbacks = readyCallbacks;

    // Listen for state changes from service worker
    this.setupStateSync();

    // Listen for bridge reconnection to re-initialize
    this.setupReconnectListener();

    // Listen for visibility changes to refresh stale state
    this.setupVisibilityListener();

    // Initialize the store (will retry if bridge not ready)
    this.initialize();
  }

  private setupReconnectListener() {
    if (this.bridge.on) {
      // Listen for disconnection to immediately mark store as not ready
      this.disconnectHandler = () => {
        this.ready = false;

        // Clear any pending state sync to prevent stale updates on reconnection
        if (this.stateSyncDebounceTimer) {
          clearTimeout(this.stateSyncDebounceTimer);
          this.stateSyncDebounceTimer = null;
        }
        this.pendingStateSync = false;
        this.stateSyncBatchStartedAt = null;

        // Anything buffered describes a stream that is now broken; the
        // reconnect path refetches the whole state instead.
        this.pendingDelta = null;
        this.pendingFullState = null;
        this.expectedDeltaSequence = null;

        // Reset initialization state so we can re-initialize cleanly
        this.isInitializing = false;
        if (this.initializationTimer) {
          clearTimeout(this.initializationTimer);
          this.initializationTimer = null;
        }
        // Note: We don't notify readyCallbacks here - they're for "became ready" events
      };
      this.bridge.on('bridge:disconnected', this.disconnectHandler);

      // Listen for reconnection to re-initialize AND re-register listeners
      this.reconnectHandler = () => {
        // Clear any pending reconnect delay timer to prevent double-init
        if (this.reconnectDelayTimer) {
          clearTimeout(this.reconnectDelayTimer);
          this.reconnectDelayTimer = null;
        }

        // CRITICAL: Re-register all event listeners on the new bridge
        // React StrictMode can cause BridgeProvider to unmount/remount, creating a new eventListenersRef
        // Since BridgeStore is cached (singleton), we must re-register our handlers
        this.reregisterEventListeners();

        // The service worker has a new port with no record of our scope, so
        // re-register before asking for state.
        if (this.bridge.setTopics && this.trackedSlices.size > 0) {
          this.bridge.setTopics([
            scopeMarkerTopic(this.storeName),
            ...[...this.trackedSlices].map((slice) => sliceTopic(this.storeName, slice)),
          ]);
        }

        // Re-initialize immediately - the bridge has already verified the connection with ping
        // No need to delay since BridgeProvider only emits bridge:connected after verification
        this.forceInitialize();
      };
      this.bridge.on('bridge:connected', this.reconnectHandler);
    }
  }

  /**
   * Re-register all event listeners on the bridge
   * Called after reconnection because React StrictMode may have created a new eventListenersRef
   * IMPORTANT: Remove existing listeners first to prevent duplicate handlers
   */
  private reregisterEventListeners() {
    if (!this.bridge.on) return;

    const eventKey = `store:${this.storeName}:stateChanged`;

    // Re-register the stateChanged handler if we have one
    // First remove to prevent duplicates, then re-add
    if (this.stateChangedHandler) {
      if (this.bridge.off) {
        this.bridge.off(eventKey, this.stateChangedHandler);
      }
      this.bridge.on(eventKey, this.stateChangedHandler);
    }

    // Re-register disconnect/reconnect handlers (remove first to prevent duplicates)
    if (this.disconnectHandler) {
      if (this.bridge.off) {
        this.bridge.off('bridge:disconnected', this.disconnectHandler);
      }
      this.bridge.on('bridge:disconnected', this.disconnectHandler);
    }
    if (this.reconnectHandler) {
      if (this.bridge.off) {
        this.bridge.off('bridge:connected', this.reconnectHandler);
      }
      this.bridge.on('bridge:connected', this.reconnectHandler);
    }
  }

  private setupVisibilityListener() {
    if (typeof document === 'undefined') return;

    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        const hiddenDuration = Date.now() - this.lastVisibleAt;

        // If tab was hidden for longer than threshold, refresh state from SW
        // This handles the case where SW restarted while tab was in background
        if (hiddenDuration > this.staleThresholdMs && this.ready && this.bridge.isConnected) {
          this.fetchAndApplyState();
        }

        this.lastVisibleAt = Date.now();
      }
    };

    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  public initialize = async () => {
    // Prevent concurrent initialization attempts
    if (this.isInitializing) {
      return;
    }

    // Clear any pending retry timer
    if (this.initializationTimer) {
      clearTimeout(this.initializationTimer);
      this.initializationTimer = null;
    }

    this.initializationAttempts++;
    this.isInitializing = true;

    try {
      // Check max attempts to prevent infinite retries
      if (this.initializationAttempts > this.maxInitializationAttempts) {
        console.error(
          `BridgeStore[${this.storeName}]: Max initialization attempts (${this.maxInitializationAttempts}) reached, giving up`,
        );
        this.isInitializing = false;
        return;
      }

      // Check if bridge is connected before attempting initialization
      if (!this.bridge.isConnected) {
        // Use exponential backoff: 500ms, 1s, 2s, 4s... capped at 5s
        const delay = Math.min(500 * Math.pow(2, this.initializationAttempts - 1), 5000);
        this.isInitializing = false;
        this.initializationTimer = setTimeout(() => this.initialize(), delay);
        return;
      }

      // Get initial state from service worker
      const state = await this.bridge.send<void, T>(`store:${this.storeName}:getState`);

      // Store initial state for reset functionality
      if (this.initialState === null) {
        this.initialState = state;
      }

      // Any delta the service worker sends from here is relative to a state at
      // or after this one, so restart gap tracking.
      this.expectedDeltaSequence = null;
      this.applyState(state);

      this.ready = true;
      this.isInitializing = false;
      this.notifyReady();
    } catch (error) {
      this.isInitializing = false;

      console.error(
        `BridgeStore[${this.storeName}]: Failed to initialize (attempt ${this.initializationAttempts}):`,
        error,
      );

      // Retry initialization after a delay if we haven't exceeded max attempts
      if (this.initializationAttempts < this.maxInitializationAttempts) {
        const delay = Math.min(1000 * Math.pow(2, this.initializationAttempts - 1), 10000);
        this.initializationTimer = setTimeout(() => this.initialize(), delay);
      } else {
        console.error(`BridgeStore[${this.storeName}]: Max attempts reached, cannot retry`);
      }
    }
  };

  private stateSyncSequence = 0;
  private pendingStateSync = false;

  /**
   * Adopt a new state, reusing references for every subtree that did not change.
   *
   * State arriving over the bridge is freshly deserialized, so every value has a
   * new identity even when it holds the same data. Without structural sharing,
   * selectors comparing with `Object.is` see a change in every slice on every
   * broadcast and every subscribed component re-renders. Reusing equal subtrees
   * means only the slices that actually changed invalidate.
   *
   * @returns Whether the state changed and listeners were notified.
   */
  private applyState(nextState: T): boolean {
    if (!nextState || typeof nextState !== 'object') {
      return false;
    }

    const shared =
      this.currentState === null ? nextState : replaceEqualDeep(this.currentState, nextState);

    // Deeply equal to what we already hold: no listener has anything to react
    // to, so skip the notification entirely.
    if (shared === this.currentState) {
      return false;
    }

    this.previousState = this.currentState;
    this.currentState = shared;
    this.notifyListeners();
    return true;
  }

  /**
   * Apply state directly from broadcast payload (no round-trip)
   */
  private applyBroadcastState(newState: T) {
    this.applyState(newState);
  }

  /**
   * Fetch state from SW (fallback when broadcast doesn't include payload)
   */
  private fetchAndApplyState() {
    // Prevent concurrent state fetches to avoid race conditions
    if (this.pendingStateSync) {
      return;
    }

    this.pendingStateSync = true;
    const currentSequence = ++this.stateSyncSequence;

    // Get new state from service worker
    this.bridge
      .send<void, T>(`store:${this.storeName}:getState`)
      .then((newState) => {
        // Only apply if this is still the latest request
        if (currentSequence === this.stateSyncSequence) {
          // A full refetch resynchronizes the delta stream: the next delta the
          // service worker sends is the first one this state has not seen.
          this.expectedDeltaSequence = null;
          this.applyState(newState);
        }
      })
      .catch((error) => {
        console.error(`BridgeStore[${this.storeName}]: Failed to sync state:`, error);
      })
      .finally(() => {
        this.pendingStateSync = false;
      });
  }

  /**
   * Fold an incoming delta into the one waiting to be applied.
   *
   * Debouncing must not drop deltas the way it can drop full-state payloads: a
   * later full state supersedes an earlier one, but a later delta only describes
   * its own changes. Merging in arrival order keeps the batch complete.
   *
   * @returns Whether the delta could be merged. `false` means a broadcast was
   *   missed and the caller should refetch the full state.
   */
  private queueDelta(delta: StateDelta<T>): boolean {
    const inSequence =
      this.expectedDeltaSequence === null || delta.sequence === this.expectedDeltaSequence;

    if (!inSequence) {
      this.pendingDelta = null;
      return false;
    }

    this.expectedDeltaSequence = delta.sequence + 1;

    if (this.pendingDelta === null) {
      this.pendingDelta = delta;
      return true;
    }

    const removed = new Set([...(this.pendingDelta.removed ?? []), ...(delta.removed ?? [])]);
    for (const key of Object.keys(delta.changed)) {
      removed.delete(key);
    }

    this.pendingDelta = {
      ...this.pendingDelta,
      changed: { ...this.pendingDelta.changed, ...delta.changed },
      ...(removed.size > 0 ? { removed: [...removed] } : {}),
      sequence: delta.sequence,
    };

    return true;
  }

  /** Applies whatever the debounce window accumulated. */
  private flushStateSync() {
    this.stateSyncDebounceTimer = null;
    this.stateSyncBatchStartedAt = null;

    const delta = this.pendingDelta;
    const fullState = this.pendingFullState;
    this.pendingDelta = null;
    this.pendingFullState = null;

    if (fullState) {
      this.applyState(fullState);
      return;
    }

    if (delta && this.currentState) {
      this.applyState(
        applyStateDelta(this.currentState as Record<string, unknown>, delta as never) as T,
      );
      return;
    }

    // Either a payload-less notification or a delta that arrived before any
    // state existed; both are resolved by asking for the whole thing.
    this.fetchAndApplyState();
  }

  /** Schedules a flush, honouring both the debounce window and its max wait. */
  private scheduleStateSync() {
    const now = Date.now();

    if (this.stateSyncBatchStartedAt === null) {
      this.stateSyncBatchStartedAt = now;
    }

    const waitedMs = now - this.stateSyncBatchStartedAt;
    const remainingMaxWait = Math.max(0, this.stateSyncMaxWaitMs - waitedMs);
    const delay = Math.min(this.stateSyncDebounceMs, remainingMaxWait);

    if (this.stateSyncDebounceTimer) {
      clearTimeout(this.stateSyncDebounceTimer);
    }

    this.stateSyncDebounceTimer = setTimeout(() => this.flushStateSync(), delay);
  }

  private setupStateSync() {
    // Listen for state updates from service worker
    if (this.bridge.on) {
      // The broadcast carries the change itself, so there is no round-trip.
      this.stateChangedHandler = (payload: unknown) => {
        if (isStateDelta<T>(payload)) {
          if (this.queueDelta(payload)) {
            this.scheduleStateSync();
          } else {
            // Sequence gap: a broadcast was missed, so merging would leave the
            // store silently stale. Resynchronize from the service worker.
            this.pendingFullState = null;
            this.expectedDeltaSequence = null;
            this.fetchAndApplyState();
          }
          return;
        }

        if (payload && typeof payload === 'object') {
          // Whole-state payload (a peer on an older version, or a first sync).
          this.pendingDelta = null;
          this.pendingFullState = payload as T;
          this.expectedDeltaSequence = null;
        }

        this.scheduleStateSync();
      };

      const eventKey = `store:${this.storeName}:stateChanged`;
      this.bridge.on(eventKey, this.stateChangedHandler);
    }
  }

  private notifyListeners = () => {
    if (!this.listeners || !this.currentState) {
      return;
    }

    // The very first state to arrive has no predecessor. Reporting it with
    // itself as `prevState` still notifies subscribers, which matters because
    // `useSyncExternalStore` will otherwise never learn that state exists.
    const previous = this.previousState ?? this.currentState;
    this.listeners.forEach((listener) => listener(this.currentState!, previous));
  };

  /**
   * Records that a selector read one top-level key, widening what the service
   * worker sends this context.
   */
  private recordSliceRead(slice: string): void {
    if (this.trackedSlices.has(slice)) {
      return;
    }

    this.trackedSlices.add(slice);

    if (this.scopeSyncTimer) {
      clearTimeout(this.scopeSyncTimer);
    }
    // Mounting a screen reads many keys in quick succession; one registration
    // for the batch is enough.
    this.scopeSyncTimer = setTimeout(() => this.syncScope(), this.scopeSyncDebounceMs);
  }

  /**
   * Tells the service worker which slices this context reads.
   *
   * Widening the scope means broadcasts for the new slices were previously
   * filtered out, so whatever is held for them may be stale — hence the
   * refetch. Before the store is ready, `initialize` is already on its way with
   * the full state and no extra round-trip is needed.
   */
  private syncScope(): void {
    this.scopeSyncTimer = null;

    if (!this.bridge.setTopics || this.trackedSlices.size === 0) {
      return;
    }

    this.bridge.setTopics([
      scopeMarkerTopic(this.storeName),
      ...[...this.trackedSlices].map((slice) => sliceTopic(this.storeName, slice)),
    ]);

    if (this.ready) {
      this.fetchAndApplyState();
    }
  }

  getState = (): T => {
    const state = this.currentState;

    // Without a bridge that understands topics there is nothing to report, so
    // skip the proxy entirely rather than pay for reads nobody will use.
    if (!this.bridge.setTopics || state === null || typeof state !== 'object') {
      return state as T;
    }

    if (this.trackedStateSource === state) {
      return this.trackedStateProxy as T;
    }

    const proxy = new Proxy(state as unknown as Record<string, unknown>, {
      get: (target, key) => {
        if (typeof key === 'string' && key in target) {
          this.recordSliceRead(key);
        }
        return target[key as string];
      },
      // Enumerating the state reads everything that is in it, so the scope has
      // to widen to match or those slices would silently stop updating.
      ownKeys: (target) => {
        for (const key of Object.keys(target)) {
          this.recordSliceRead(key);
        }
        return Reflect.ownKeys(target);
      },
      has: (target, key) => {
        if (typeof key === 'string' && key in target) {
          this.recordSliceRead(key);
        }
        return Reflect.has(target, key);
      },
    }) as T;

    this.trackedStateSource = state;
    this.trackedStateProxy = proxy;

    return proxy;
  };

  setState(partial: T | Partial<T> | ((state: T) => T | Partial<T>), replace?: false): void;
  setState(state: T | ((state: T) => T), replace: true): void;
  setState(partial: any, replace?: boolean): void {
    // Handle function updates locally first (functions can't be serialized)
    let actualUpdate: any;

    if (typeof partial === 'function') {
      if (this.currentState === null) {
        return;
      }
      // Execute the function to get the actual update
      actualUpdate = partial(this.currentState);
    } else {
      actualUpdate = partial;
    }

    // Store state for potential rollback
    const stateBeforeUpdate = this.currentState ? { ...this.currentState } : null;

    // Apply optimistic update for immediate UI feedback
    this.applyOptimisticUpdate(actualUpdate, replace);

    // Send the resolved state update to service worker
    const payload = { partial: actualUpdate, replace };

    this.bridge.send(`store:${this.storeName}:setState`, payload).catch((error: any) => {
      console.error(`BridgeStore[${this.storeName}]: Failed to update state via bridge:`, error);

      // Rollback optimistic update on failure
      if (stateBeforeUpdate !== null) {
        this.applyState(stateBeforeUpdate);
      }
    });
  }

  private applyOptimisticUpdate(actualUpdate: any, replace?: boolean): void {
    if (!this.currentState) {
      return;
    }

    // Routed through applyState so a write that sets a field to the value it
    // already holds does not notify, and so untouched slices keep their
    // identities for selectors.
    this.applyState(replace ? actualUpdate : { ...this.currentState, ...actualUpdate });
  }

  subscribe = (listener: (state: T, prevState: T) => void): (() => void) => {
    if (!this.listeners) {
      console.error('BridgeStore: Cannot subscribe, listeners not initialized');
      return () => {};
    }

    this.listeners.add(listener);
    // Replay the current state so a subscriber joining after initialization is
    // not left waiting for the next change.
    if (this.currentState) {
      listener(this.currentState, this.previousState ?? this.currentState);
    }

    return () => {
      if (this.listeners) {
        this.listeners.delete(listener);
      }
    };
  };

  // Additional StoreApi methods
  destroy = () => {
    // Clear initialization timer
    if (this.initializationTimer) {
      clearTimeout(this.initializationTimer);
      this.initializationTimer = null;
    }

    // Clear debounce timer
    if (this.stateSyncDebounceTimer) {
      clearTimeout(this.stateSyncDebounceTimer);
      this.stateSyncDebounceTimer = null;
    }
    this.stateSyncBatchStartedAt = null;
    this.pendingDelta = null;
    this.pendingFullState = null;

    if (this.scopeSyncTimer) {
      clearTimeout(this.scopeSyncTimer);
      this.scopeSyncTimer = null;
    }

    // Clear reconnect delay timer
    if (this.reconnectDelayTimer) {
      clearTimeout(this.reconnectDelayTimer);
      this.reconnectDelayTimer = null;
    }

    // Remove bridge event listeners to prevent memory leaks
    if (this.bridge.off) {
      if (this.reconnectHandler) {
        this.bridge.off('bridge:connected', this.reconnectHandler);
        this.reconnectHandler = null;
      }
      if (this.disconnectHandler) {
        this.bridge.off('bridge:disconnected', this.disconnectHandler);
        this.disconnectHandler = null;
      }
      if (this.stateChangedHandler) {
        this.bridge.off(`store:${this.storeName}:stateChanged`, this.stateChangedHandler);
        this.stateChangedHandler = null;
      }
    }

    // Remove visibility listener
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }

    if (this.listeners) {
      this.listeners.clear();
    }
    this.readyCallbacks.clear();
  };

  getInitialState = (): T => {
    return this.getState();
  };

  isReady = (): boolean => {
    return this.ready;
  };

  onReady = (callback: () => void): (() => void) => {
    if (this.ready) {
      // If already ready, call immediately
      callback();
    } else {
      this.readyCallbacks.add(callback);
    }

    // Return unsubscribe function
    return () => {
      this.readyCallbacks.delete(callback);
    };
  };

  reset = (): void => {
    if (this.initialState !== null) {
      // Check if bridge is connected
      if (!this.bridge.isConnected) {
        this.applyState({ ...this.initialState } as T);
        return;
      }

      // Store state for potential rollback
      const stateBeforeReset = this.currentState ? { ...this.currentState } : null;

      // Optimistic reset for immediate UI feedback
      this.expectedDeltaSequence = null;
      this.applyState({ ...this.initialState } as T);

      // Send reset command to service worker
      this.bridge.send(`store:${this.storeName}:reset`).catch((error: any) => {
        console.error(`BridgeStore[${this.storeName}]: Failed to reset state via bridge:`, error);

        // Rollback on failure
        if (stateBeforeReset !== null) {
          this.applyState(stateBeforeReset);
        }
      });
    }
  };

  private notifyReady = () => {
    this.readyCallbacks.forEach((callback) => callback());
    this.readyCallbacks.clear();
  };

  /**
   * Force re-initialization of the store (useful for debugging or after reconnection)
   */
  public forceInitialize = async (): Promise<void> => {
    // Clear any pending initialization
    if (this.initializationTimer) {
      clearTimeout(this.initializationTimer);
      this.initializationTimer = null;
    }

    this.ready = false;
    this.isInitializing = false;
    this.initializationAttempts = 0; // Reset attempt counter
    await this.initialize();
  };

  /**
   * Get debug information about the store state
   */
  public getDebugInfo = () => {
    return {
      storeName: this.storeName,
      ready: this.ready,
      isInitializing: this.isInitializing,
      bridgeConnected: this.bridge.isConnected,
      hasCurrentState: this.currentState !== null,
      hasInitialState: this.initialState !== null,
      readyCallbacksCount: this.readyCallbacks.size,
      initializationAttempts: this.initializationAttempts,
      maxInitializationAttempts: this.maxInitializationAttempts,
    };
  };

  /**
   * Update the bridge reference and re-register all event listeners.
   * Called when createBridgeStore receives a new bridge object (e.g., after React remount).
   * This is critical for React StrictMode which causes double-mounting.
   */
  public updateBridge = (newBridge: BridgeWithEvents): void => {
    if (this.bridge === newBridge) {
      return; // Same bridge, nothing to do
    }

    this.bridge = newBridge;

    // Re-register all event listeners on the new bridge
    this.reregisterEventListeners();
  };
}

// Store instance cache - prevents multiple instances per store name (React Strict Mode fix)
const storeCache = new Map<string, BridgeStore<any>>();

// Factory function to create bridge store (with singleton pattern per store name)
export function createBridgeStore<T>(
  bridge: BridgeWithEvents,
  initialState?: T,
  storeName = 'default',
  readyCallbacks: Set<() => void> = new Set(),
): CentralStore<T> {
  // Return cached instance if it exists (prevents duplicate subscriptions in React Strict Mode)
  if (storeCache.has(storeName)) {
    const cached = storeCache.get(storeName)!;

    // CRITICAL: Update bridge reference and re-register listeners!
    // React StrictMode causes BridgeProvider to remount, creating a new bridge object
    // with a new eventListenersRef. We must update our reference and re-register.
    cached.updateBridge(bridge);

    // Add any new ready callbacks to the existing instance
    readyCallbacks.forEach((cb) => cached.onReady(cb));
    return cached as unknown as CentralStore<T>;
  }

  const store = new BridgeStore<T>(bridge, initialState, storeName, readyCallbacks);
  storeCache.set(storeName, store);

  return store;
}

// Helper to clear the store cache (useful for testing)
export function clearStoreCache(): void {
  storeCache.clear();
}

/**
 * Destroy a specific store and remove it from cache.
 * Call this when a store is no longer needed to free memory.
 * @param storeName - The name of the store to destroy
 */
export function destroyStore(storeName: string): void {
  const store = storeCache.get(storeName);
  if (store) {
    store.destroy();
    storeCache.delete(storeName);
  }
}
