import type { CentralStore } from './types.js';

// Shared logging flag (aligned with BridgeProvider)
const STORE_ENABLE_LOGS: boolean =
  typeof globalThis !== 'undefined' && (globalThis as any).__CHROMA_ENABLE_LOGS__ === false
    ? false
    : true;

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
}

export interface BridgeWithHandlers extends Bridge {
  register: (key: string, handler: (payload?: any) => any) => void;
  broadcast: (key: string, payload: any) => void;
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
        if (STORE_ENABLE_LOGS) {
          console.log(
            `BridgeStore[${this.storeName}]: Bridge disconnected, marking store as not ready`,
          );
        }
        this.ready = false;

        // Clear any pending state sync to prevent stale updates on reconnection
        if (this.stateSyncDebounceTimer) {
          clearTimeout(this.stateSyncDebounceTimer);
          this.stateSyncDebounceTimer = null;
        }
        this.pendingStateSync = false;

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
        if (STORE_ENABLE_LOGS) {
          console.log(
            `BridgeStore[${this.storeName}]: Bridge reconnected, re-registering listeners and re-initializing...`,
          );
        }
        // Clear any pending reconnect delay timer to prevent double-init
        if (this.reconnectDelayTimer) {
          clearTimeout(this.reconnectDelayTimer);
          this.reconnectDelayTimer = null;
        }

        // CRITICAL: Re-register all event listeners on the new bridge
        // React StrictMode can cause BridgeProvider to unmount/remount, creating a new eventListenersRef
        // Since BridgeStore is cached (singleton), we must re-register our handlers
        this.reregisterEventListeners();

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
      if (STORE_ENABLE_LOGS) {
        console.log(`BridgeStore[${this.storeName}]: Re-registering listener for '${eventKey}'`);
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
          if (STORE_ENABLE_LOGS) {
            console.log(
              `BridgeStore[${this.storeName}]: Tab visible after ${Math.round(hiddenDuration / 1000)}s, refreshing state`,
            );
          }
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
        if (STORE_ENABLE_LOGS) {
          console.error(
            `BridgeStore[${this.storeName}]: Max initialization attempts (${this.maxInitializationAttempts}) reached, giving up`,
          );
        }
        this.isInitializing = false;
        return;
      }

      // Check if bridge is connected before attempting initialization
      if (!this.bridge.isConnected) {
        // Only log on first attempt or every 3rd attempt to reduce spam
        if (this.initializationAttempts === 1 || this.initializationAttempts % 3 === 0) {
          if (STORE_ENABLE_LOGS) {
            console.log(
              `BridgeStore[${this.storeName}]: Waiting for bridge connection (attempt ${this.initializationAttempts}/${this.maxInitializationAttempts})...`,
            );
          }
        }

        // Use exponential backoff: 500ms, 1s, 2s, 4s... capped at 5s
        const delay = Math.min(500 * Math.pow(2, this.initializationAttempts - 1), 5000);
        this.isInitializing = false;
        this.initializationTimer = setTimeout(() => this.initialize(), delay);
        return;
      }

      // Get initial state from service worker
      const state = await this.bridge.send<void, T>(`store:${this.storeName}:getState`);

      this.previousState = this.currentState;
      this.currentState = state;

      // Store initial state for reset functionality
      if (this.initialState === null) {
        this.initialState = state;
      }

      this.notifyListeners();

      this.ready = true;
      this.isInitializing = false;
      if (STORE_ENABLE_LOGS) {
        console.log(`BridgeStore[${this.storeName}]: Initialized successfully`);
      }
      this.notifyReady();
    } catch (error) {
      this.isInitializing = false;

      if (STORE_ENABLE_LOGS) {
        console.error(
          `BridgeStore[${this.storeName}]: Failed to initialize (attempt ${this.initializationAttempts}):`,
          error,
        );
      }

      // Retry initialization after a delay if we haven't exceeded max attempts
      if (this.initializationAttempts < this.maxInitializationAttempts) {
        const delay = Math.min(1000 * Math.pow(2, this.initializationAttempts - 1), 10000);
        if (STORE_ENABLE_LOGS) {
          console.log(`BridgeStore[${this.storeName}]: Retrying initialization in ${delay}ms...`);
        }
        this.initializationTimer = setTimeout(() => this.initialize(), delay);
      } else {
        if (STORE_ENABLE_LOGS) {
          console.error(`BridgeStore[${this.storeName}]: Max attempts reached, cannot retry`);
        }
      }
    }
  };

  private stateSyncSequence = 0;
  private pendingStateSync = false;

  /**
   * Apply state directly from broadcast payload (no round-trip)
   */
  private applyBroadcastState(newState: T) {
    if (!newState || typeof newState !== 'object') {
      if (STORE_ENABLE_LOGS) {
        console.warn(`BridgeStore[${this.storeName}]: Invalid broadcast state, ignoring`);
      }
      return;
    }

    if (STORE_ENABLE_LOGS) {
      console.log(
        `BridgeStore[${this.storeName}]: 📦 Applying broadcast state, notifying ${this.listeners?.size ?? 0} listeners`,
      );
    }

    this.previousState = this.currentState;
    this.currentState = newState;
    this.notifyListeners();
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
          this.previousState = this.currentState;
          this.currentState = newState;
          this.notifyListeners();
        }
      })
      .catch((error) => {
        if (STORE_ENABLE_LOGS) {
          console.error(`BridgeStore[${this.storeName}]: Failed to sync state:`, error);
        }
      })
      .finally(() => {
        this.pendingStateSync = false;
      });
  }

  private setupStateSync() {
    // Listen for state updates from service worker
    if (this.bridge.on) {
      // Handler receives the full state in the broadcast payload - no need to re-fetch!
      this.stateChangedHandler = (payload: unknown) => {
        if (STORE_ENABLE_LOGS) {
          console.log(`BridgeStore[${this.storeName}]: 📡 Received stateChanged broadcast`, {
            hasPayload: !!payload,
            payloadType: typeof payload,
          });
        }

        // Debounce rapid state change events to reduce re-renders
        if (this.stateSyncDebounceTimer) {
          clearTimeout(this.stateSyncDebounceTimer);
        }

        this.stateSyncDebounceTimer = setTimeout(() => {
          this.stateSyncDebounceTimer = null;

          // Use the broadcast payload directly if available (eliminates round-trip!)
          if (payload && typeof payload === 'object') {
            this.applyBroadcastState(payload as T);
          } else {
            // Fallback to fetch if no payload (shouldn't happen normally)
            this.fetchAndApplyState();
          }
        }, this.stateSyncDebounceMs);
      };

      const eventKey = `store:${this.storeName}:stateChanged`;
      if (STORE_ENABLE_LOGS) {
        console.log(`BridgeStore[${this.storeName}]: Registering listener for '${eventKey}'`);
      }
      this.bridge.on(eventKey, this.stateChangedHandler);
    } else {
      if (STORE_ENABLE_LOGS) {
        console.warn(`BridgeStore[${this.storeName}]: Bridge does not support event listening`);
      }
    }
  }

  private notifyListeners = () => {
    if (!this.listeners) {
      if (STORE_ENABLE_LOGS) {
        console.warn('BridgeStore: listeners not initialized');
      }
      return;
    }

    if (this.currentState && this.previousState) {
      this.listeners.forEach((listener) => listener(this.currentState!, this.previousState!));
    }
  };

  getState = (): T => {
    return this.currentState as T;
  };

  setState(partial: T | Partial<T> | ((state: T) => T | Partial<T>), replace?: false): void;
  setState(state: T | ((state: T) => T), replace: true): void;
  setState(partial: any, replace?: boolean): void {
    // Handle function updates locally first (functions can't be serialized)
    let actualUpdate: any;

    if (typeof partial === 'function') {
      if (this.currentState === null) {
        if (STORE_ENABLE_LOGS) {
          console.warn('BridgeStore: Cannot execute function update, state not initialized');
        }
        return;
      }
      // Execute the function to get the actual update
      actualUpdate = partial(this.currentState);
    } else {
      actualUpdate = partial;
    }

    // Check if bridge is connected before attempting update
    if (!this.bridge.isConnected) {
      if (STORE_ENABLE_LOGS) {
        console.warn(
          `BridgeStore[${this.storeName}]: Bridge disconnected, state update queued locally only`,
        );
      }
    }

    // Store state for potential rollback
    const stateBeforeUpdate = this.currentState ? { ...this.currentState } : null;

    // Apply optimistic update for immediate UI feedback
    this.applyOptimisticUpdate(actualUpdate, replace);

    // Send the resolved state update to service worker
    const payload = { partial: actualUpdate, replace };

    this.bridge.send(`store:${this.storeName}:setState`, payload).catch((error: any) => {
      if (STORE_ENABLE_LOGS) {
        console.error(`BridgeStore[${this.storeName}]: Failed to update state via bridge:`, error);
      }

      // Rollback optimistic update on failure
      if (stateBeforeUpdate !== null) {
        if (STORE_ENABLE_LOGS) {
          console.warn(
            `BridgeStore[${this.storeName}]: Rolling back optimistic update due to bridge error`,
          );
        }
        this.previousState = this.currentState;
        this.currentState = stateBeforeUpdate;
        this.notifyListeners();
      }
    });
  }

  private applyOptimisticUpdate(actualUpdate: any, replace?: boolean): void {
    if (this.currentState) {
      this.previousState = this.currentState;
      if (replace) {
        this.currentState = actualUpdate;
      } else {
        this.currentState = { ...this.currentState, ...actualUpdate };
      }
      this.notifyListeners();
    }
  }

  subscribe = (listener: (state: T, prevState: T) => void): (() => void) => {
    if (!this.listeners) {
      if (STORE_ENABLE_LOGS) {
        console.error('BridgeStore: Cannot subscribe, listeners not initialized');
      }
      return () => {};
    }

    this.listeners.add(listener);
    // Call listener with current state if available
    if (this.currentState && this.previousState) {
      listener(this.currentState, this.previousState);
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
        if (STORE_ENABLE_LOGS) {
          console.warn(
            `BridgeStore[${this.storeName}]: Bridge disconnected, reset applied locally only`,
          );
        }
        this.previousState = this.currentState;
        this.currentState = { ...this.initialState };
        this.notifyListeners();
        return;
      }

      // Store state for potential rollback
      const stateBeforeReset = this.currentState ? { ...this.currentState } : null;

      // Optimistic reset for immediate UI feedback
      this.previousState = this.currentState;
      this.currentState = { ...this.initialState };
      this.notifyListeners();

      // Send reset command to service worker
      this.bridge.send(`store:${this.storeName}:reset`).catch((error: any) => {
        if (STORE_ENABLE_LOGS) {
          console.error(`BridgeStore[${this.storeName}]: Failed to reset state via bridge:`, error);
        }

        // Rollback on failure
        if (stateBeforeReset !== null) {
          if (STORE_ENABLE_LOGS) {
            console.warn(`BridgeStore[${this.storeName}]: Rolling back reset due to bridge error`);
          }
          this.previousState = this.currentState;
          this.currentState = stateBeforeReset;
          this.notifyListeners();
        }
      });
    } else {
      if (STORE_ENABLE_LOGS) {
        console.warn(`BridgeStore[${this.storeName}]: Cannot reset, initial state not available`);
      }
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
    if (STORE_ENABLE_LOGS) {
      console.debug(`BridgeStore[${this.storeName}]: Force re-initialization requested`);
    }

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

    if (STORE_ENABLE_LOGS) {
      console.log(
        `BridgeStore[${this.storeName}]: Updating bridge reference and re-registering listeners`,
      );
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
    if (STORE_ENABLE_LOGS) {
      console.log(`BridgeStore[${storeName}]: Returning cached instance (singleton)`);
    }

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

  if (STORE_ENABLE_LOGS) {
    console.log(`BridgeStore[${storeName}]: Created new instance (cached)`);
  }

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
    if (STORE_ENABLE_LOGS) {
      console.log(`BridgeStore[${storeName}]: Destroying store and removing from cache`);
    }
    store.destroy();
    storeCache.delete(storeName);
  }
}
