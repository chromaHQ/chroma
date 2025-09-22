import type { CentralStore } from './types.js';

// Import bridge types from chroma core/react
export interface Bridge {
  send: <Req = unknown, Res = unknown>(key: string, payload?: Req) => Promise<Res>;
  isConnected: boolean;
}

export interface BridgeWithEvents extends Bridge {
  on?: (key: string, handler: (payload: any) => void) => void;
}

export interface BridgeWithHandlers extends Bridge {
  register: (key: string, handler: (payload?: any) => any) => void;
  broadcast: (key: string, payload: any) => void;
  on?: (key: string, handler: (payload: any) => void) => void;
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

  constructor(bridge: BridgeWithEvents, initialState?: T, storeName = 'default') {
    this.bridge = bridge;
    this.currentState = initialState || null;
    this.previousState = initialState || null;
    this.initialState = initialState || null;
    this.storeName = storeName;

    // Listen for state changes from service worker
    this.setupStateSync();
    // Initialize the store
    this.initialize();
  }

  public initialize = async () => {
    try {
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
      this.notifyReady();
    } catch (error) {
      console.warn('Failed to initialize bridge store:', error);
    }
  };

  private setupStateSync() {
    // Listen for state updates from service worker
    if (this.bridge.on) {
      this.bridge.on(`store:${this.storeName}:stateChanged`, (newState: T) => {
        this.previousState = this.currentState;
        this.currentState = newState;
        this.notifyListeners();
      });
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

    // Send the resolved state update to service worker
    const payload = { partial: actualUpdate, replace };

    this.bridge.send(`store:${this.storeName}:setState`, payload).catch((error: any) => {
      console.error('Failed to update state via bridge:', error);
    });

    // Optimistic update for immediate UI feedback
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
    if (this.listeners) {
      this.listeners.clear();
    }
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
      // Send reset command to service worker
      this.bridge.send(`store:${this.storeName}:reset`).catch((error: any) => {
        console.error('Failed to reset state via bridge:', error);
      });

      // Optimistic reset for immediate UI feedback
      this.previousState = this.currentState;
      this.currentState = { ...this.initialState };
      this.notifyListeners();
    } else {
      console.warn('BridgeStore: Cannot reset, initial state not available');
    }
  };

  private notifyReady = () => {
    this.readyCallbacks.forEach((callback) => callback());
    this.readyCallbacks.clear();
  };
}

// Factory function to create bridge store
export function createBridgeStore<T>(
  bridge: BridgeWithEvents,
  initialState?: T,
  storeName = 'default',
): CentralStore<T> {
  return new BridgeStore<T>(bridge, initialState, storeName);
}
