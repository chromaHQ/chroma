import type { StateCreator } from 'zustand';
import type { PersistOptions } from './types.js';
import { replaceEqualDeep } from './structuralShare.js';

/**
 * Storage layout.
 *
 * State is written one key per top-level slice rather than as a single blob, so
 * changing one field costs one small write instead of re-serializing everything
 * persisted. An index key records which slices exist, so loading does not have
 * to enumerate unrelated extension storage.
 */
const SLICE_SEPARATOR = '::';

function sliceKey(name: string, slice: string): string {
  return `${name}${SLICE_SEPARATOR}${slice}`;
}

function indexKey(name: string): string {
  return `${name}${SLICE_SEPARATOR}__index`;
}

function storageGet(keys: string[] | null): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys as never, (result) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(result);
      }
    });
  });
}

function storageSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) {
        console.error('Failed to persist state:', chrome.runtime.lastError);
      }
      resolve();
    });
  });
}

function storageRemove(keys: string[]): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, () => {
      // A key that was never written is not an error worth reporting.
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

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

      const selectPersisted = (state: S): Record<string, unknown> =>
        (options.partialize ? options.partialize(state) : state) as Record<string, unknown>;

      // The slices last written, so a change confined to one slice does not
      // rewrite the others.
      let persistedSlices: Record<string, unknown> = {};
      let hasPersistedBaseline = false;

      /**
       * Reads the per-slice layout, falling back to the single-blob layout
       * written by earlier versions.
       *
       * Migration writes every slice and the index in one `set` call so a
       * failure cannot leave an index pointing at slices that were never
       * written, and only removes the legacy blob once that has landed.
       */
      const readPersistedState = async (): Promise<{
        state: Record<string, unknown> | null;
        layout: 'slices' | 'legacy';
      }> => {
        const index = await storageGet([indexKey(key)]);
        const sliceNames: string[] | undefined = index[indexKey(key)];

        if (Array.isArray(sliceNames)) {
          const stored = await storageGet(sliceNames.map((slice) => sliceKey(key, slice)));
          const state: Record<string, unknown> = {};

          for (const slice of sliceNames) {
            const value = stored[sliceKey(key, slice)];
            if (value !== undefined) {
              state[slice] = value;
            }
          }

          return { state, layout: 'slices' };
        }

        const legacy = await storageGet([key]);
        return {
          state: (legacy[key] as Record<string, unknown> | undefined) ?? null,
          layout: 'legacy',
        };
      };

      // Attempt to load persisted state
      const loadPersistedState = async () => {
        try {
          if (!chrome?.storage?.local) {
            isInitialized = true;
            setupPersistence();
            return;
          }

          const { state: persisted, layout } = await readPersistedState();

          if (persisted) {
            // Merge persisted state with initial state to preserve slice structure
            const mergedState = { ...initialState, ...persisted } as S;
            set(mergedState);

            if (layout === 'slices') {
              // Already in the current layout: adopt what is on disk as the
              // baseline so the first write only covers slices that differ from
              // it, and so slices no longer selected get cleaned up.
              persistedSlices = persisted;
              hasPersistedBaseline = true;
              await persistState(mergedState);
            } else {
              // Rewrites in the per-slice layout and drops the legacy blob.
              await persistState(mergedState, { migrateFromLegacy: true });
            }
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

      const persistState = async (
        state: S,
        { migrateFromLegacy = false }: { migrateFromLegacy?: boolean } = {},
      ) => {
        if (!chrome?.storage?.local) {
          return;
        }

        const snapshot = selectPersisted(state);
        const writes: Record<string, unknown> = {};
        let changedSlices = 0;

        for (const slice of Object.keys(snapshot)) {
          const previous = persistedSlices[slice];

          // `replaceEqualDeep` hands back the previous value when nothing
          // changed, which turns an identity check into a deep comparison.
          if (
            hasPersistedBaseline &&
            slice in persistedSlices &&
            replaceEqualDeep(previous, snapshot[slice]) === previous
          ) {
            continue;
          }

          writes[sliceKey(key, slice)] = snapshot[slice];
          changedSlices += 1;
        }

        const nextSliceNames = Object.keys(snapshot);
        const removedSlices = Object.keys(persistedSlices).filter((slice) => !(slice in snapshot));
        const indexChanged =
          migrateFromLegacy ||
          !hasPersistedBaseline ||
          removedSlices.length > 0 ||
          nextSliceNames.length !== Object.keys(persistedSlices).length;

        if (changedSlices === 0 && !indexChanged) {
          return;
        }

        if (indexChanged) {
          writes[indexKey(key)] = nextSliceNames;
        }

        persistedSlices = snapshot;
        hasPersistedBaseline = true;

        await storageSet(writes);

        if (removedSlices.length > 0) {
          await storageRemove(removedSlices.map((slice) => sliceKey(key, slice)));
        }

        if (migrateFromLegacy) {
          // Only once the new layout is durable.
          await storageRemove([key]);
        }
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
