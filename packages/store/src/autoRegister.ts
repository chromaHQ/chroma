import type { CentralStore } from './types.js';

export function autoRegisterStoreHandlers<T>(
  store: CentralStore<T>,
  storeName: string = 'default',
) {
  // Validate store immediately
  if (!store) {
    throw new Error('autoRegisterStoreHandlers: store parameter is required');
  }

  // Validate store has required methods
  if (typeof store.getState !== 'function') {
    throw new Error('autoRegisterStoreHandlers: store must have getState method');
  }
  if (typeof store.setState !== 'function') {
    throw new Error('autoRegisterStoreHandlers: store must have setState method');
  }

  console.log(`[Store] Creating handlers for store "${storeName}"`, {
    hasGetState: typeof store.getState === 'function',
    hasSetState: typeof store.setState === 'function',
  });

  // Create classes with the store instance bound at creation time
  class AutoGetStoreStateMessage {
    handle(): T {
      console.log(`[Store] GetState handler called for "${storeName}"`);

      if (!store) {
        console.error(`[Store] Store instance not available for "${storeName}"`);
        throw new Error('Store instance not available');
      }

      try {
        const state = store.getState();
        console.log(`[Store] GetState returning state for "${storeName}"`, {
          hasState: state !== undefined && state !== null,
          stateType: typeof state,
        });
        return state;
      } catch (error) {
        console.error(`[Store] GetState failed for "${storeName}":`, error);
        throw error;
      }
    }
  }

  class AutoSetStoreStateMessage {
    handle(...args: any[]): T {
      if (!store) {
        throw new Error('Store instance not available');
      }

      // Handle different argument patterns
      let partial: any;
      let replace: boolean = false;

      if (args.length === 1 && args[0] && typeof args[0] === 'object') {
        const payload = args[0];

        if ('partial' in payload) {
          // Standard format: { partial, replace }
          ({ partial, replace = false } = payload);
        } else {
          // Direct state update (payload is the state itself)
          partial = payload;
          replace = false;
        }
      } else if (args.length >= 2) {
        // Multiple arguments: (partial, replace)
        partial = args[0];
        replace = args[1] || false;
      } else if (args.length === 1) {
        // Single argument that's not an object
        partial = args[0];
        replace = false;
      } else {
        return store.getState();
      }

      if (partial === undefined) {
        return store.getState();
      }

      if (replace) {
        store.setState(partial as T, true);
      } else {
        store.setState(partial);
      }

      const updatedState = store.getState();

      // No need to broadcast here - the store subscription will handle broadcasting
      return updatedState;
    }
  }

  class AutoResetStoreMessage {
    handle(): T {
      console.log(`[Store] Reset handler called for "${storeName}"`);

      if (!store) {
        console.error(`[Store] Store instance not available for "${storeName}"`);
        throw new Error('Store instance not available');
      }

      try {
        if (typeof store.reset === 'function') {
          store.reset();
        }
        return store.getState();
      } catch (error) {
        console.error(`[Store] Reset failed for "${storeName}":`, error);
        throw error;
      }
    }
  }

  // Return the registered message classes for reference (if needed)
  return {
    GetStoreStateMessage: AutoGetStoreStateMessage,
    SetStoreStateMessage: AutoSetStoreStateMessage,
    ResetStoreMessage: AutoResetStoreMessage,
  };
}
