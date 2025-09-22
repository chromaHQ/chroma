/**
 * Generic action hook factory for any store instance.
 * Usage:
 *   const store = createStore(mergeSlices(sliceA, sliceB));
 *   <StoreProvider store={store}> ... </StoreProvider>
 *   export const useWalletActions = createActionHookForStore(store, walletActions);
 *   export const useCounterActions = createActionHookForStore(store, counterActions);
 * All hooks and actions share the same StoreProvider/context.
 */
export function createActionHookForStore<
  S extends Record<string, any>,
  ActionMap extends Record<string, (...args: any[]) => void>,
>(
  store: CentralStore<S>,
  actionsFactory: (actions: ReturnType<typeof useStoreActions<S>>) => ActionMap,
): () => ActionMap {
  return function useCustomActions(): ActionMap {
    const baseActions = useStoreActions(store);
    return useMemo(() => actionsFactory(baseActions), [baseActions]);
  };
}

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
        store.setState((state) => updater(state));
      },
      replace: (newState: T) => {
        store.setState(newState, true);
      },
      setState: store.setState.bind(store),
    }),
    [store],
  );
}

export function createStoreHooks<T extends Record<string, any>>() {
  const StoreContext = createContext<CentralStore<T> | null>(null);

  function StoreProvider({ store, children }: { store: CentralStore<T>; children: ReactNode }) {
    const storeRef = useRef(store);
    return React.createElement(StoreContext.Provider, { value: storeRef.current }, children);
  }

  function useStore<U>(selector: (state: T) => U): U {
    const store = useContext(StoreContext);
    if (!store) throw new Error('useStore must be used within a StoreProvider');
    return useCentralStore(store, selector);
  }

  function useStoreInstance(): CentralStore<T> {
    const store = useContext(StoreContext);
    if (!store) throw new Error('useStoreInstance must be used within a StoreProvider');
    return store;
  }

  function useActions() {
    const store = useStoreInstance();
    return useStoreActions(store);
  }

  type ActionKeys<T> = {
    [K in keyof T]: T[K] extends (...args: any[]) => any ? K : never;
  }[keyof T];

  function useAction<K extends ActionKeys<T>>(actionKey: K): T[K] {
    const store = useStoreInstance();
    return React.useCallback(
      (...args: any[]) => {
        const fn = store.getState()[actionKey];
        if (typeof fn !== 'function') {
          throw new Error('useAction only supports function actions');
        }
        return fn(...args);
      },
      [store, actionKey],
    ) as T[K];
  }

  /**
   * Generic action hook creator for any state type.
   * Usage:
   *   export const useWalletActions = createActionHook<WalletState>(walletActions);
   *   export const useCounterActions = createActionHook<CounterState>(counterActions);
   */
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
    createActionHook,
    StoreProvider,
    useStore,
    useStoreInstance,
    useActions,
    useAction,
  };
}
