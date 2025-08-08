import * as React from 'react';
import { useContext, createContext, ReactNode, useRef, useMemo } from 'react';
import { useCentralStore } from './react.js';
import type { CentralStore } from './types.js';

/**
 * Store actions helper: exposes update, updateWith, replace, setState
 * Actions should be defined in your slice and accessed via useActions.
 */
function useStoreActions<T extends Record<string, any>>(store: CentralStore<T>) {
  return useMemo(
    () => ({
      update: (partial: Partial<T>) => {
        store.setState((state) => ({ ...state, ...partial }));
      },
      updateWith: (updater: (state: T) => Partial<T>) => {
        store.setState((state) => ({ ...state, ...updater(state) }));
      },
      replace: (newState: T) => {
        store.setState(newState, true);
      },
      setState: store.setState.bind(store),
    }),
    [store],
  );
}

/**
 * Create store hooks for context-based state and actions.
 * Use useStore for state selection and useActions for auto-wired actions.
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

  // Hook for selecting a single action from context (no need to pass store)
  function useAction<K extends keyof T>(actionKey: K): T[K] {
    const store = useStoreInstance();
    const action = useCentralStore(store, (state) => state[actionKey]);
    return action;
  }

  return {
    StoreProvider,
    useStore,
    useStoreInstance,
    useActions,
    useAction,
  };
}
