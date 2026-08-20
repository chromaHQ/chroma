import type { StateCreator } from 'zustand';
import type { PersistOptions } from './types.js';
import { replaceEqualDeep } from './structuralShare.js';

export function chromeStoragePersist<S>(
  options: PersistOptions & { onReady?: () => void } = {} as any,
) {
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
          // Notify that persistence is ready
          if (options.onReady) {
            options.onReady();
          }
        }
      };

      // Debounce timer for persistence to avoid I/O storms on rapid state changes
      let persistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
      const PERSIST_DEBOUNCE_MS = 500;

      // What was last written, so a change confined to non-persisted state does
      // not trigger another write of identical bytes.
      let lastPersistedSnapshot: unknown = undefined;

      const selectPersisted = (state: S) =>
        options.partialize ? options.partialize(state) : state;

      // Helper to persist state
      const persistState = async (state: S) => {
        if (!chrome?.storage?.local) {
          return;
        }

        const snapshot = selectPersisted(state);

        // `replaceEqualDeep` returns the previous value when nothing changed,
        // which makes an identity check a deep-equality check.
        if (
          lastPersistedSnapshot !== undefined &&
          replaceEqualDeep(lastPersistedSnapshot, snapshot) === lastPersistedSnapshot
        ) {
          return;
        }

        lastPersistedSnapshot = snapshot;

        return new Promise<void>((resolve) => {
          chrome.storage.local.set({ [key]: snapshot }, () => {
            if (chrome.runtime.lastError) {
              console.error(`Failed to persist state for "${key}":`, chrome.runtime.lastError);
            }
            resolve();
          });
        });
      };

      // Set up persistence subscription with debouncing (only once)
      const setupPersistence = () => {
        if (persistenceSetup) return;
        persistenceSetup = true;

        store.subscribe((state) => {
          // Debounce persistence writes to avoid I/O storms
          // This prevents excessive chrome.storage.local.set() calls during rapid state updates
          if (persistDebounceTimer) {
            clearTimeout(persistDebounceTimer);
          }
          persistDebounceTimer = setTimeout(() => {
            persistDebounceTimer = null;
            persistState(state);
          }, PERSIST_DEBOUNCE_MS);
        });
      };

      // Load persisted state immediately
      loadPersistedState();

      return initialState;
    };
}
