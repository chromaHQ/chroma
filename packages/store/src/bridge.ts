import type { CentralStore } from './types.js';

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

    // Initialize the store (will retry if bridge not ready)
    this.initialize();
  }

  private setupReconnectListener() {
    if (this.bridge.on) {
      this.bridge.on('bridge:connected', () => {
        console.log(`BridgeStore[${this.storeName}]: Bridge reconnected, re-initializing...`);
        // Reset state and re-initialize on reconnection
        this.forceInitialize();
      });
    }
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
        // Only log on first attempt or every 3rd attempt to reduce spam
        if (this.initializationAttempts === 1 || this.initializationAttempts % 3 === 0) {
          console.log(
            `BridgeStore[${this.storeName}]: Waiting for bridge connection (attempt ${this.initializationAttempts}/${this.maxInitializationAttempts})...`,
          );
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
      console.log(`BridgeStore[${this.storeName}]: Initialized successfully`);
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
        console.log(`BridgeStore[${this.storeName}]: Retrying initialization in ${delay}ms...`);
        this.initializationTimer = setTimeout(() => this.initialize(), delay);
      } else {
        console.error(`BridgeStore[${this.storeName}]: Max attempts reached, cannot retry`);
      }
    }
  };

  private stateSyncSequence = 0;
  private pendingStateSync = false;

  private setupStateSync() {
    // Listen for state updates from service worker
    if (this.bridge.on) {
      this.bridge.on(`store:${this.storeName}:stateChanged`, () => {
        // Prevent concurrent state fetches to avoid race conditions
        if (this.pendingStateSync) {
          return;
        }

        this.pendingStateSync = true;
        const currentSequence = ++this.stateSyncSequence;

        // get new state from service worker
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
            console.error(`BridgeStore[${this.storeName}]: Failed to sync state:`, error);
          })
          .finally(() => {
            this.pendingStateSync = false;
          });
      });
    } else {
      console.warn(`BridgeStore[${this.storeName}]: Bridge does not support event listening`);
    }
  }

  private notifyListeners = () => {
    if (!this.listeners) {
      console.warn('BridgeStore: listeners not initialized');
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
        console.warn('BridgeStore: Cannot execute function update, state not initialized');
        return;
      }
      actualUpdate = partial(this.currentState);
    } else {
      actualUpdate = partial;
    }

    // Check if bridge is connected before attempting update
    if (!this.bridge.isConnected) {
      console.warn(
        `BridgeStore[${this.storeName}]: Bridge disconnected, state update queued locally only`,
      );
      // Still apply optimistic update but don't try to send
      this.applyOptimisticUpdate(actualUpdate, replace);
      return;
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
        console.warn(
          `BridgeStore[${this.storeName}]: Rolling back optimistic update due to bridge error`,
        );
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
      console.error('BridgeStore: Cannot subscribe, listeners not initialized');
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
      // Otherwise, add to callbacks
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
        console.warn(
          `BridgeStore[${this.storeName}]: Bridge disconnected, reset applied locally only`,
        );
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
        console.error(`BridgeStore[${this.storeName}]: Failed to reset state via bridge:`, error);

        // Rollback on failure
        if (stateBeforeReset !== null) {
          console.warn(`BridgeStore[${this.storeName}]: Rolling back reset due to bridge error`);
          this.previousState = this.currentState;
          this.currentState = stateBeforeReset;
          this.notifyListeners();
        }
      });
    } else {
      console.warn(`BridgeStore[${this.storeName}]: Cannot reset, initial state not available`);
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
    console.debug(`BridgeStore[${this.storeName}]: Force re-initialization requested`);

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
}

// Factory function to create bridge store
export function createBridgeStore<T>(
  bridge: BridgeWithEvents,
  initialState?: T,
  storeName = 'default',
  readyCallbacks: Set<() => void> = new Set(),
): CentralStore<T> {
  return new BridgeStore<T>(bridge, initialState, storeName, readyCallbacks);
}
