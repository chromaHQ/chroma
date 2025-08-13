import type { StateCreator } from 'zustand';
import type { PersistOptions } from './types.js';

export function chromeStoragePersist<S>(options: PersistOptions) {
  return (config: StateCreator<S>): StateCreator<S> =>
    (set, get, store) => {
      const key = options.name;
      let isInitialized = false;
      let persistenceSetup = false;

      // Create initial state from slices
      const initialState = config(set, get, store);

      // Attempt to load persisted state
      const loadPersistedState = async () => {
        try {
          if (!chrome?.storage?.local) {
            console.warn(`Chrome storage not available for "${key}", using memory only`);
            isInitialized = true;
            setupPersistence();
            return;
          }

          const result = await new Promise<Record<string, any>>((resolve, reject) => {
            chrome.storage.local.get([key], (result) => {
              if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
              } else {
                resolve(result);
              }
            });
          });

          if (result[key]) {
            // Merge persisted state with initial state to preserve slice structure
            const mergedState = { ...initialState, ...result[key] };
            set(mergedState);
          } else {
            // Persist the initial state immediately so it's available for other contexts
            await persistState(initialState);
          }
        } catch (error) {
          console.error(`Failed to load persisted state for "${key}":`, error);
        } finally {
          isInitialized = true;
          setupPersistence();
        }
      };

      // Helper to persist state
      const persistState = async (state: S) => {
        if (!chrome?.storage?.local) {
          return;
        }

        return new Promise<void>((resolve) => {
          chrome.storage.local.set({ [key]: state }, () => {
            if (chrome.runtime.lastError) {
              console.error(`Failed to persist state for "${key}":`, chrome.runtime.lastError);
            }
            resolve();
          });
        });
      };

      // Set up persistence subscription (only once)
      const setupPersistence = () => {
        if (persistenceSetup) return;
        persistenceSetup = true;

        store.subscribe((state) => {
          persistState(state);
        });
      };

      // Load persisted state immediately
      loadPersistedState();

      return initialState;
    };
}
