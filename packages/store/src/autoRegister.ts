import type { CentralStore } from './types.js';

export function autoRegisterStoreHandlers<T>(store: CentralStore<T>) {
  // Validate store immediately
  if (!store) {
    throw new Error('autoRegisterStoreHandlers: store parameter is required');
  }

  // Create classes with the store instance bound at creation time
  class AutoGetStoreStateMessage {
    handle(): T {
      if (!store) {
        throw new Error('Store instance not available');
      }

      return store.getState();
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

        if ('partial' in payload && 'replace' in payload) {
          // Standard format: { partial, replace }
          ({ partial, replace } = payload);
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

      return store.getState();
    }
  }

  class AutoSubscribeToStoreMessage {
    handle(): void {
      if (!store) {
        throw new Error('Store instance not available');
      }

      // When UI subscribes, setup broadcasting
      store.subscribe((state: T, prevState: T) => {
        // Broadcasting is handled automatically by chroma's bridge system
      });
    }
  } // Return the registered message classes for reference (if needed)
  return {
    GetStoreStateMessage: AutoGetStoreStateMessage,
    SetStoreStateMessage: AutoSetStoreStateMessage,
    SubscribeToStoreMessage: AutoSubscribeToStoreMessage,
  };
}
