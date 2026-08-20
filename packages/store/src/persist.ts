import type { StateCreator } from 'zustand';
import type { PersistOptions } from './types.js';
import { replaceEqualDeep } from './structuralShare.js';
import {
  attemptsKey,
  effectiveQuotaBytes,
  hasHeadroomForMigration,
  indexKey,
  layoutKey,
  MAX_MIGRATION_ATTEMPTS,
  SLICE_LAYOUT,
  sliceKey,
  statusKey,
  STATUS_HISTORY,
} from './storageLayout.js';
import type { PersistenceEvent, PersistenceStatus } from './persistenceEvents.js';

/**
 * Persists state to `chrome.storage.local`.
 *
 * Two layouts are supported: a single blob under the store name, and one key
 * per top-level slice. The slice layout makes a write proportional to what
 * changed rather than to the size of the store. `storageLayout.ts` documents
 * the rules that make moving between them safe.
 *
 * Beyond the migration itself, persistence fails closed: reads are retried, a
 * read that cannot be completed disables writing for the session so slice
 * defaults never overwrite the stored copy, and a failed write does not advance
 * the baseline.
 */

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
 * empty extension, so a transient failure is worth a couple of attempts before
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

/** @returns Whether the write landed. Never resolves true on `lastError`. */
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

function storageBytesInUse(): Promise<number> {
  return new Promise((resolve) => {
    if (typeof chrome.storage.local.getBytesInUse !== 'function') {
      resolve(0);
      return;
    }
    chrome.storage.local.getBytesInUse(null, (bytes) => {
      void chrome.runtime.lastError;
      resolve(bytes ?? 0);
    });
  });
}

type Layout = 'blob' | 'slices';

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

      /** Which layout this session writes. Only ever advanced by a verified migration. */
      let layout: Layout = 'blob';

      /**
       * Records what persistence did, durably.
       *
       * Written to storage rather than logged because the service worker is
       * ephemeral and production builds strip `console`. Failing to record a
       * diagnostic must never affect the data path, so errors here are ignored.
       */
      const report = async (event: PersistenceEvent): Promise<void> => {
        try {
          options.onEvent?.(event);
        } catch {
          /* An app's reporter is not allowed to break persistence. */
        }

        try {
          const stored = await storageGetOnce([statusKey(key)]);
          const previous = stored[statusKey(key)] as PersistenceStatus | undefined;

          const status: PersistenceStatus = {
            layout,
            history: [{ at: Date.now(), event }, ...(previous?.history ?? [])].slice(
              0,
              STATUS_HISTORY,
            ),
          };

          await storageSet({ [statusKey(key)]: status });
        } catch {
          /* Diagnostics must not be able to break persistence. */
        }
      };

      // Create initial state from slices
      const initialState = config(set, get, store);

      const selectPersisted = (state: S): Record<string, unknown> =>
        (options.partialize ? options.partialize(state) : state) as Record<string, unknown>;

      // What was last written, so an unchanged snapshot is not rewritten. Only
      // advanced after a write actually succeeds.
      let persistedSlices: Record<string, unknown> = {};
      let hasPersistedBaseline = false;

      /** Set when a read finds the slice layout incomplete, for reporting. */
      let tornSlices: string[] | null = null;

      const readSliceLayout = async (
        sliceNames: string[],
      ): Promise<Record<string, unknown> | null> => {
        const stored = await storageGet(sliceNames.map((slice) => sliceKey(key, slice)));
        const missing = sliceNames.filter((slice) => !(sliceKey(key, slice) in stored));

        if (missing.length > 0) {
          console.warn(`[store] Slice layout for "${key}" is missing ${missing.join(', ')}.`);
          tornSlices = missing;
          return null;
        }

        const state: Record<string, unknown> = {};
        for (const slice of sliceNames) {
          state[slice] = stored[sliceKey(key, slice)];
        }
        return state;
      };

      /**
       * Reads whichever copy the layout marker says is authoritative.
       *
       * The marker is the whole point: with it there is never a question of
       * which copy is newer, so a stale leftover from an aborted migration can
       * never be mistaken for current data.
       */
      const readPersistedState = async (): Promise<Record<string, unknown> | null> => {
        const head = await storageGet([layoutKey(key), indexKey(key), key]);
        const blob = head[key] as Record<string, unknown> | undefined;
        const sliceNames: string[] | undefined = head[indexKey(key)];

        if (head[layoutKey(key)] === SLICE_LAYOUT && Array.isArray(sliceNames)) {
          layout = 'slices';
          const state = await readSliceLayout(sliceNames);

          if (state) {
            return state;
          }

          if (blob) {
            // Torn slice layout with the blob still present: the blob is whole,
            // so prefer it and let this session keep writing that way.
            console.warn(`[store] Falling back to the whole-state copy for "${key}".`);
            layout = 'blob';
            void report({
              type: 'layout-torn',
              missing: tornSlices ?? [],
              recovered: 'blob',
            });
            return blob;
          }

          void report({ type: 'layout-torn', missing: tornSlices ?? [], recovered: 'none' });

          // Nothing trustworthy to load. Failing here disables writes for the
          // session rather than replacing a torn layout with defaults.
          throw new Error(`Slice layout for "${key}" is incomplete and has no fallback`);
        }

        if (blob) {
          return blob;
        }

        // An interim build wrote slices without ever committing a layout
        // marker. Read them rather than stranding the install.
        if (Array.isArray(sliceNames) && sliceNames.length > 0) {
          const state = await readSliceLayout(sliceNames);
          if (state && Object.keys(state).length > 0) {
            return state;
          }
        }

        return null;
      };

      /**
       * Moves a blob install onto the slice layout.
       *
       * Ordering is the safety: write, read back, commit the marker, and only
       * then delete the copy being replaced. Every failure leaves the blob
       * authoritative and the half-written slices inert.
       */
      const migrateToSliceLayout = async (snapshot: Record<string, unknown>): Promise<void> => {
        const attemptsRead = await storageGet([attemptsKey(key)]);
        const attempts: number = attemptsRead[attemptsKey(key)] ?? 0;

        if (attempts >= MAX_MIGRATION_ATTEMPTS) {
          await report({
            type: 'migration-skipped',
            reason: 'too-many-attempts',
            bytesInUse: 0,
            quotaBytes: 0,
          });
          return;
        }

        const startedAt = Date.now();

        const bytesInUse = await storageBytesInUse();
        // Zero when `unlimitedStorage` applies, which the headroom check reads
        // as unbounded.
        const quota = effectiveQuotaBytes();

        if (!hasHeadroomForMigration(bytesInUse, quota, snapshot)) {
          // Both copies exist at once during migration. Starting without room
          // for that is how a partial write ends up deleting the only copy.
          console.warn(
            `[store] Not migrating "${key}" to the slice layout: ${bytesInUse} bytes in ` +
              `use leaves no room for a second copy under a ${quota} byte quota.`,
          );
          await report({
            type: 'migration-skipped',
            reason: 'no-headroom',
            bytesInUse,
            quotaBytes: quota,
          });
          return;
        }

        const noteFailure = async (reason: string) => {
          console.warn(`[store] Migration of "${key}" aborted: ${reason}`);
          await storageSet({ [attemptsKey(key)]: attempts + 1 });
          await report({ type: 'migration-aborted', reason, attempt: attempts + 1 });
        };

        const sliceNames = Object.keys(snapshot);
        const writes: Record<string, unknown> = { [indexKey(key)]: sliceNames };
        for (const slice of sliceNames) {
          writes[sliceKey(key, slice)] = snapshot[slice];
        }

        if (!(await storageSet(writes))) {
          await noteFailure('the write did not land');
          return;
        }

        const readBack = await readSliceLayoutQuietly(sliceNames);

        if (!readBack) {
          await noteFailure('the slices did not read back');
          return;
        }

        const expected = asStored(snapshot);

        if (expected === null) {
          await noteFailure('the state could not be serialized');
          return;
        }

        if (replaceEqualDeep(expected, readBack) !== expected) {
          await noteFailure('the slices did not read back identical');
          return;
        }

        // The commit point. Before this line the blob is authoritative; after
        // it, the slices are.
        if (!(await storageSet({ [layoutKey(key)]: SLICE_LAYOUT }))) {
          await noteFailure('the layout marker did not land');
          return;
        }

        layout = 'slices';
        persistedSlices = snapshot;
        hasPersistedBaseline = true;

        await storageRemove([key, attemptsKey(key)]);
        await report({
          type: 'migrated',
          slices: sliceNames.length,
          durationMs: Date.now() - startedAt,
        });
      };

      /**
       * What storage will hand back for a value.
       *
       * `chrome.storage.local` serializes with JSON semantics, so a `Set`
       * returns as `{}`, a `Date` as a string, and `undefined` disappears.
       * Verification has to compare against that, not against the live object,
       * or any state holding one of them can never verify.
       *
       * @returns The normalized value, or `null` when it cannot be serialized
       *   at all — in which case the write would not have landed either.
       */
      const asStored = (value: unknown): unknown | null => {
        try {
          return JSON.parse(JSON.stringify(value));
        } catch {
          return null;
        }
      };

      /** Read-back for verification; a failure here is a verification failure. */
      const readSliceLayoutQuietly = async (
        sliceNames: string[],
      ): Promise<Record<string, unknown> | null> => {
        try {
          const stored = await storageGet([
            indexKey(key),
            ...sliceNames.map((slice) => sliceKey(key, slice)),
          ]);

          const storedIndex: string[] | undefined = stored[indexKey(key)];
          if (!Array.isArray(storedIndex) || storedIndex.length !== sliceNames.length) {
            return null;
          }

          const state: Record<string, unknown> = {};
          for (const slice of sliceNames) {
            if (!(sliceKey(key, slice) in stored)) return null;
            state[slice] = stored[sliceKey(key, slice)];
          }
          return state;
        } catch {
          return null;
        }
      };

      const loadPersistedState = async () => {
        try {
          if (!chrome?.storage?.local) {
            setupPersistence();
            return;
          }

          const persisted = await readPersistedState();

          if (persisted) {
            // Merge persisted state with initial state to preserve slice structure
            const mergedState = { ...initialState, ...persisted } as S;
            set(mergedState);

            if (layout === 'slices') {
              persistedSlices = persisted;
              hasPersistedBaseline = true;
              await report({ type: 'loaded', source: 'slices' });
              await persistState(mergedState);
            } else {
              await report({ type: 'loaded', source: 'blob' });
              await migrateToSliceLayout(selectPersisted(mergedState));
            }
          } else {
            await report({ type: 'loaded', source: 'none' });
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
          await report({
            type: 'writes-disabled',
            reason: error instanceof Error ? error.message : String(error),
          });
        } finally {
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

      const persistState = async (state: S): Promise<void> => {
        if (!chrome?.storage?.local || writesDisabled) {
          return;
        }

        const snapshot = selectPersisted(state);

        // `replaceEqualDeep` hands back the previous value when nothing changed,
        // which turns an identity check into a deep comparison.
        if (
          hasPersistedBaseline &&
          replaceEqualDeep(persistedSlices, snapshot) === persistedSlices
        ) {
          return;
        }

        if (layout === 'blob') {
          if (await storageSet({ [key]: snapshot })) {
            persistedSlices = snapshot;
            hasPersistedBaseline = true;
          } else {
            void report({ type: 'write-failed', reason: 'blob write did not land' });
          }
          return;
        }

        const writes: Record<string, unknown> = {};
        for (const slice of Object.keys(snapshot)) {
          const previous = persistedSlices[slice];
          if (
            hasPersistedBaseline &&
            slice in persistedSlices &&
            replaceEqualDeep(previous, snapshot[slice]) === previous
          ) {
            continue;
          }
          writes[sliceKey(key, slice)] = snapshot[slice];
        }

        const nextSliceNames = Object.keys(snapshot);
        const droppedSlices = Object.keys(persistedSlices).filter((slice) => !(slice in snapshot));

        if (droppedSlices.length > 0 || !hasPersistedBaseline) {
          writes[indexKey(key)] = nextSliceNames;
        }

        if (Object.keys(writes).length === 0) {
          return;
        }

        if (!(await storageSet(writes))) {
          // Baseline deliberately not advanced: the next change retries.
          void report({ type: 'write-failed', reason: 'slice write did not land' });
          return;
        }

        persistedSlices = snapshot;
        hasPersistedBaseline = true;

        // Only once the index no longer names them.
        if (droppedSlices.length > 0) {
          await storageRemove(droppedSlices.map((slice) => sliceKey(key, slice)));
        }
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
