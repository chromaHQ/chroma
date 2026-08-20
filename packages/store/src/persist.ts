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
 *
 * Splitting a blob into several keys introduces a failure mode a blob does not
 * have — a torn read or a half-applied write — so every path here is written to
 * fail closed. Nothing is deleted until its replacement has been read back, and
 * a load that does not complete cleanly disables writing for the session rather
 * than letting an empty in-memory state overwrite good data on disk.
 */
const SLICE_SEPARATOR = '::';

function sliceKey(name: string, slice: string): string {
  return `${name}${SLICE_SEPARATOR}${slice}`;
}

function indexKey(name: string): string {
  return `${name}${SLICE_SEPARATOR}__index`;
}

/** Rejects on failure so a transient read error is never mistaken for "no data". */
function storageGetOnce(keys: string[]): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message ?? 'storage.get failed'));
      } else {
        resolve(result);
      }
    });
  });
}

/** How many times a read is retried before the session gives up on persistence. */
const READ_ATTEMPTS = 3;

/**
 * Reads with a short retry.
 *
 * Giving up on a read costs the session its persistence and shows the user an
 * empty wallet, so a transient failure is worth a couple of attempts before
 * concluding the data cannot be reached.
 */
async function storageGet(keys: string[]): Promise<Record<string, any>> {
  let lastFailure: unknown;

  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
    try {
      return await storageGetOnce(keys);
    } catch (error) {
      lastFailure = error;
      if (attempt < READ_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      }
    }
  }

  throw lastFailure;
}

/** @returns Whether every key was written. */
function storageSet(items: Record<string, unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) {
        console.error('[store] Failed to persist state:', chrome.runtime.lastError.message);
        resolve(false);
        return;
      }
      resolve(true);
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

interface LoadResult {
  state: Record<string, unknown> | null;
  layout: 'slices' | 'legacy';
  /** A legacy blob still on disk that has not been superseded yet. */
  legacyPresent: boolean;
}

export function chromeStoragePersist<S>(
  options: PersistOptions & { onReady?: () => void } = {} as any,
) {
  return (config: StateCreator<S>): StateCreator<S> =>
    (set, get, store) => {
      const key = options.name;
      let persistenceSetup = false;

      /**
       * Set when the persisted state could not be read with confidence.
       *
       * The in-memory state then holds slice defaults rather than the user's
       * data, and writing that back would destroy what is still on disk. A
       * session that cannot read does not write.
       */
      let writesDisabled = false;

      // Create initial state from slices
      const initialState = config(set, get, store);

      const selectPersisted = (state: S): Record<string, unknown> =>
        (options.partialize ? options.partialize(state) : state) as Record<string, unknown>;

      // The slices last written, so a change confined to one slice does not
      // rewrite the others. Only advanced after a write actually succeeds.
      let persistedSlices: Record<string, unknown> = {};
      let hasPersistedBaseline = false;

      /**
       * Reads the per-slice layout, falling back to the single-blob layout
       * written by earlier versions.
       *
       * A slice named by the index but absent from storage means the layout is
       * torn. The legacy blob is preferred in that case, because it is whole.
       */
      const readPersistedState = async (): Promise<LoadResult> => {
        // One read for both layouts: which one is authoritative is decided
        // below, and a second round trip to find out is wasted boot time.
        const head = await storageGet([indexKey(key), key]);
        const sliceNames: string[] | undefined = head[indexKey(key)];
        const legacyState = head[key] as Record<string, unknown> | undefined;

        if (Array.isArray(sliceNames)) {
          const stored = await storageGet(sliceNames.map((slice) => sliceKey(key, slice)));
          const missing = sliceNames.filter((slice) => !(sliceKey(key, slice) in stored));

          if (missing.length > 0 && legacyState) {
            console.warn(
              `[store] Slice layout for "${key}" is missing ${missing.join(', ')}; ` +
                'falling back to the previous whole-state copy.',
            );
            return { state: legacyState, layout: 'legacy', legacyPresent: true };
          }

          const state: Record<string, unknown> = {};
          for (const slice of sliceNames) {
            const value = stored[sliceKey(key, slice)];
            if (value !== undefined) {
              state[slice] = value;
            }
          }

          return { state, layout: 'slices', legacyPresent: legacyState !== undefined };
        }

        return {
          state: legacyState ?? null,
          layout: 'legacy',
          legacyPresent: legacyState !== undefined,
        };
      };

      /**
       * Confirms the per-slice layout can be read back before the whole-state
       * copy it replaces is deleted.
       *
       * Without this, a write that reported success but did not land would take
       * the only intact copy of the user's data with it.
       */
      const verifySliceLayout = async (snapshot: Record<string, unknown>): Promise<boolean> => {
        try {
          const sliceNames = Object.keys(snapshot);
          const readBack = await storageGet([
            indexKey(key),
            ...sliceNames.map((slice) => sliceKey(key, slice)),
          ]);

          const storedIndex: string[] | undefined = readBack[indexKey(key)];
          if (!Array.isArray(storedIndex) || storedIndex.length !== sliceNames.length) {
            return false;
          }

          return sliceNames.every((slice) => sliceKey(key, slice) in readBack);
        } catch {
          return false;
        }
      };

      const loadPersistedState = async () => {
        try {
          if (!chrome?.storage?.local) {
            setupPersistence();
            return;
          }

          const { state: persisted, layout, legacyPresent } = await readPersistedState();

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

              if (legacyPresent) {
                // Left behind by a migration that was interrupted before it
                // could clean up. The slice layout just read fine, so it is
                // safe to drop now.
                await storageRemove([key]);
              }
            } else {
              await migrateToSliceLayout(mergedState);
            }
          } else {
            // Persist the initial state immediately so it's available for other contexts
            await persistState(initialState);
          }
        } catch (error) {
          writesDisabled = true;
          console.error(
            `[store] Could not read persisted state for "${key}"; persistence is ` +
              'disabled for this session so the stored copy is not overwritten.',
            error,
          );
        } finally {
          setupPersistence();
          // Notify that persistence is ready
          if (options.onReady) {
            options.onReady();
          }
        }
      };

      /**
       * Moves a whole-state install onto the per-slice layout.
       *
       * Ordering is what makes this safe: write, verify by reading back, and
       * only then delete the copy being replaced. A failure at any step leaves
       * the original intact and the migration is retried on the next boot.
       */
      const migrateToSliceLayout = async (state: S) => {
        const written = await persistState(state, { rewriteEverything: true });

        if (!written) {
          console.warn(
            `[store] Migration of "${key}" to the slice layout did not complete; ` +
              'keeping the previous copy and retrying on next start.',
          );
          return;
        }

        if (!(await verifySliceLayout(selectPersisted(state)))) {
          console.warn(
            `[store] Slice layout for "${key}" could not be read back; keeping the ` +
              'previous copy.',
          );
          return;
        }

        await storageRemove([key]);
      };

      // Debounce timer for persistence to avoid I/O storms on rapid state changes
      let persistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
      const PERSIST_DEBOUNCE_MS = 500;

      /** @returns Whether everything that needed writing was written. */
      const persistState = async (
        state: S,
        { rewriteEverything = false }: { rewriteEverything?: boolean } = {},
      ): Promise<boolean> => {
        if (!chrome?.storage?.local || writesDisabled) {
          return false;
        }

        const snapshot = selectPersisted(state);
        const writes: Record<string, unknown> = {};
        let changedSlices = 0;

        for (const slice of Object.keys(snapshot)) {
          const previous = persistedSlices[slice];

          // `replaceEqualDeep` hands back the previous value when nothing
          // changed, which turns an identity check into a deep comparison.
          if (
            !rewriteEverything &&
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
          rewriteEverything ||
          !hasPersistedBaseline ||
          removedSlices.length > 0 ||
          nextSliceNames.length !== Object.keys(persistedSlices).length;

        if (changedSlices === 0 && !indexChanged) {
          return true;
        }

        if (indexChanged) {
          writes[indexKey(key)] = nextSliceNames;
        }

        // One call, so the index can never name slices that were not written
        // alongside it.
        const written = await storageSet(writes);

        if (!written) {
          // The baseline deliberately does not advance: a failed write must be
          // retried by the next change, not silently treated as persisted.
          return false;
        }

        persistedSlices = snapshot;
        hasPersistedBaseline = true;

        if (removedSlices.length > 0) {
          await storageRemove(removedSlices.map((slice) => sliceKey(key, slice)));
        }

        return true;
      };

      // Set up persistence subscription with debouncing (only once)
      const setupPersistence = () => {
        if (persistenceSetup) return;
        persistenceSetup = true;

        store.subscribe((state) => {
          if (writesDisabled) return;

          // Debounce persistence writes to avoid I/O storms
          // This prevents excessive chrome.storage.local.set() calls during rapid state updates
          if (persistDebounceTimer) {
            clearTimeout(persistDebounceTimer);
          }
          persistDebounceTimer = setTimeout(() => {
            persistDebounceTimer = null;
            void persistState(state);
          }, PERSIST_DEBOUNCE_MS);
        });
      };

      // Load persisted state immediately
      loadPersistedState();

      return initialState;
    };
}
