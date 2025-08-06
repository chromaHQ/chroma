import * as React from 'react';
import { useContext, createContext, ReactNode, useRef, useMemo } from 'react';
import { useCentralStore } from './react.js';
import type { CentralStore } from './types.js';

/**
 * Store actions helper (inlined from actions.ts)
 */
function useStoreActions<T extends Record<string, any>>(store: CentralStore<T>) {
  return useMemo(
    () => ({
      // Update state with partial data
      update: (partial: Partial<T>) => {
        store.setState((state) => ({ ...state, ...partial }));
      },

      // Update state with a function
      updateWith: (updater: (state: T) => Partial<T>) => {
        store.setState((state) => ({ ...state, ...updater(state) }));
      },

      // Replace entire state
      replace: (newState: T) => {
        store.setState(newState, true);
      },

      // Direct access to setState
      setState: store.setState.bind(store),
    }),
    [store],
  );
}

/**
 * Create a complete store hook factory with typed providers and action creators
 * This prevents confusion by providing only the hooks you need, not global ones
 */
export function createStoreHooks<T extends Record<string, any>>() {
  const StoreContext = createContext<CentralStore<T> | null>(null);

  // Store Provider component
  function StoreProvider({ store, children }: { store: CentralStore<T>; children: ReactNode }) {
    const storeRef = useRef(store);
    return React.createElement(StoreContext.Provider, { value: storeRef.current }, children);
  }

  // Hook for selecting state values (always requires selector)
  function useStore<U>(selector: (state: T) => U): U {
    const store = useContext(StoreContext);
    if (!store) throw new Error('useStore must be used within a StoreProvider');
    return useCentralStore(store, selector);
  }

  // Hook for getting store instance
  function useStoreInstance(): CentralStore<T> {
    const store = useContext(StoreContext);
    if (!store) throw new Error('useStoreInstance must be used within a StoreProvider');
    return store;
  }

  // Hook for basic actions (auto-wired, no store parameter needed)
  function useActions() {
    const store = useStoreInstance();
    return useStoreActions(store);
  }

  // Factory for creating custom action hooks
  function createActionHook<ActionMap extends Record<string, (...args: any[]) => void>>(
    actionsFactory: (actions: ReturnType<typeof useStoreActions<T>>) => ActionMap,
  ) {
    return function useCustomActions(): ActionMap {
      const store = useStoreInstance();
      const baseActions = useStoreActions(store);
      return useMemo(() => actionsFactory(baseActions), [baseActions]);
    };
  }

  return {
    StoreProvider,
    useStore,
    useStoreInstance,
    useActions,
    createActionHook,
  };
}
