/**
 * @fileoverview Persistence writes state to `chrome.storage.local` on a
 * debounce. These tests pin the three things that decide what it costs: what
 * gets written, what is skipped, and how an existing single-blob install is
 * carried over.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { chromeStoragePersist } from '../src/persist';

interface TestState extends Record<string, unknown> {
  vault: string | null;
  subnets: Record<string, number>;
}

const originalChrome = globalThis.chrome;
let lastError: { message: string } | undefined;
let set: ReturnType<typeof vi.fn>;
let remove: ReturnType<typeof vi.fn>;
let storage: Record<string, unknown>;
/** Injected failures, so the fail-closed paths can be exercised. */
let failWrites: boolean;
let failReadsFor: string | null;

function mountStore(options: Parameters<typeof chromeStoragePersist>[0]) {
  return createStore<TestState>(
    chromeStoragePersist<TestState>(options)(() => ({
      vault: 'sealed',
      subnets: { 1: 1 },
    })),
  );
}

/** Every key written across all calls, flattened. */
function written(): Record<string, unknown> {
  return Object.assign({}, ...set.mock.calls.map(([items]) => items));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  storage = {};

  failWrites = false;
  failReadsFor = null;

  set = vi.fn((items: Record<string, unknown>, callback?: () => void) => {
    if (failWrites) {
      lastError = { message: 'QUOTA_BYTES quota exceeded' };
      callback?.();
      lastError = undefined;
      return;
    }
    Object.assign(storage, items);
    callback?.();
  });
  remove = vi.fn((keys: string[], callback?: () => void) => {
    for (const key of keys) delete storage[key];
    callback?.();
  });

  globalThis.chrome = {
    get runtime() {
      return { lastError };
    },
    storage: {
      local: {
        get: (keys: string[], callback: (result: Record<string, unknown>) => void) => {
          if (failReadsFor && keys.some((k) => k === failReadsFor)) {
            lastError = { message: 'storage unavailable' };
            callback({});
            lastError = undefined;
            return;
          }
          const result: Record<string, unknown> = {};
          for (const key of keys) {
            if (key in storage) result[key] = storage[key];
          }
          callback(result);
        },
        set,
        remove,
      },
    },
  } as never;
});

afterEach(() => {
  globalThis.chrome = originalChrome;
  vi.useRealTimers();
});

describe('chromeStoragePersist', () => {
  it('writes one key per slice rather than a single blob', async () => {
    mountStore({ name: 'app' });
    await vi.advanceTimersByTimeAsync(10);

    expect(written()).toMatchObject({
      'app::vault': 'sealed',
      'app::subnets': { 1: 1 },
      'app::__index': ['vault', 'subnets'],
    });
    // The whole-state key is what the per-slice layout replaces.
    expect(storage.app).toBeUndefined();
  });

  it('rewrites only the slice that changed', async () => {
    const store = mountStore({ name: 'app' });
    await vi.advanceTimersByTimeAsync(10);
    set.mockClear();

    store.setState({ vault: 'unsealed' });
    await vi.advanceTimersByTimeAsync(600);

    expect(set).toHaveBeenCalledTimes(1);
    // `subnets` did not move, so it is not re-serialized.
    expect(Object.keys(set.mock.calls[0][0])).toEqual(['app::vault']);
  });

  it('skips the write entirely when nothing persisted changed', async () => {
    const store = mountStore({
      name: 'app',
      partialize: ({ subnets: _subnets, ...persisted }: TestState) => persisted,
    });
    await vi.advanceTimersByTimeAsync(10);
    set.mockClear();

    // Only the excluded slice moves, so there is nothing new to write.
    store.setState({ subnets: { 1: 2 } });
    await vi.advanceTimersByTimeAsync(600);

    expect(set).not.toHaveBeenCalled();
  });

  it('writes only what partialize selects', async () => {
    mountStore({
      name: 'app',
      partialize: ({ subnets: _subnets, ...persisted }: TestState) => persisted,
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(storage['app::subnets']).toBeUndefined();
    expect(storage['app::__index']).toEqual(['vault']);
  });

  it('adopts an existing single-blob install and clears it', async () => {
    storage.app = { vault: 'restored', subnets: { 7: 7 } };

    const store = mountStore({ name: 'app' });
    await vi.advanceTimersByTimeAsync(10);

    expect(store.getState().vault).toBe('restored');
    expect(storage['app::vault']).toBe('restored');
    expect(storage['app::subnets']).toEqual({ 7: 7 });
    // Removed only after the new layout is durable.
    expect(storage.app).toBeUndefined();
  });

  it('loads from the per-slice layout without touching the legacy key', async () => {
    storage['app::__index'] = ['vault', 'subnets'];
    storage['app::vault'] = 'from-slices';
    storage['app::subnets'] = { 3: 3 };

    const store = mountStore({ name: 'app' });
    await vi.advanceTimersByTimeAsync(10);

    expect(store.getState().vault).toBe('from-slices');
    expect(store.getState().subnets).toEqual({ 3: 3 });
  });

  it('drops the storage key for a slice that partialize stops selecting', async () => {
    storage['app::__index'] = ['vault', 'subnets'];
    storage['app::vault'] = 'sealed';
    storage['app::subnets'] = { 1: 1 };

    mountStore({
      name: 'app',
      partialize: ({ subnets: _subnets, ...persisted }: TestState) => persisted,
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(storage['app::subnets']).toBeUndefined();
    expect(storage['app::__index']).toEqual(['vault']);
  });
});

/**
 * A blob install that is mid-upgrade or has been damaged is where a bad
 * migration turns into a user who cannot open their wallet. Every path below
 * has to end with the user's data still on disk.
 */
describe('chromeStoragePersist failure handling', () => {
  it('never writes after a read it could not complete', async () => {
    storage.app = { vault: 'sealed', subnets: { 1: 1 } };
    failReadsFor = 'app::__index';

    const store = mountStore({ name: 'app' });
    await vi.advanceTimersByTimeAsync(10);
    set.mockClear();

    store.setState({ vault: 'overwritten-in-memory' });
    await vi.advanceTimersByTimeAsync(600);

    // The in-memory state fell back to slice defaults; writing it back would
    // destroy the only copy of the user's data.
    expect(set).not.toHaveBeenCalled();
    expect(storage.app).toEqual({ vault: 'sealed', subnets: { 1: 1 } });
  });

  it('recovers from a read that fails once before succeeding', async () => {
    storage.app = { vault: 'sealed', subnets: { 1: 1 } };

    let attempts = 0;
    const realGet = (globalThis.chrome as never as { storage: { local: { get: unknown } } }).storage
      .local.get as (keys: string[], cb: (result: Record<string, unknown>) => void) => void;

    (globalThis.chrome as never as { storage: { local: { get: unknown } } }).storage.local.get = (
      keys: string[],
      cb: (result: Record<string, unknown>) => void,
    ) => {
      attempts += 1;
      if (attempts === 1) {
        lastError = { message: 'transient' };
        cb({});
        lastError = undefined;
        return;
      }
      realGet(keys, cb);
    };

    const store = mountStore({ name: 'app' });
    await vi.advanceTimersByTimeAsync(500);

    // A single hiccup must not cost the session its data.
    expect(store.getState().vault).toBe('sealed');
    expect(attempts).toBeGreaterThan(1);
  });

  it('keeps the previous copy when the migration write fails', async () => {
    storage.app = { vault: 'sealed', subnets: { 1: 1 } };
    failWrites = true;

    const store = mountStore({ name: 'app' });
    await vi.advanceTimersByTimeAsync(10);

    // Loaded fine, so the user sees their data...
    expect(store.getState().vault).toBe('sealed');
    // ...and the copy it came from is still there to try again from.
    expect(storage.app).toEqual({ vault: 'sealed', subnets: { 1: 1 } });
    expect(storage['app::vault']).toBeUndefined();
  });

  it('keeps the previous copy when the new layout cannot be read back', async () => {
    storage.app = { vault: 'sealed', subnets: { 1: 1 } };

    // Reports success but drops the index, so verification must catch it.
    set.mockImplementation((items: Record<string, unknown>, callback?: () => void) => {
      const { 'app::__index': _dropped, ...rest } = items;
      Object.assign(storage, rest);
      callback?.();
    });

    mountStore({ name: 'app' });
    await vi.advanceTimersByTimeAsync(10);

    expect(storage.app).toEqual({ vault: 'sealed', subnets: { 1: 1 } });
  });

  it('removes the previous copy only once the new layout verifies', async () => {
    storage.app = { vault: 'sealed', subnets: { 1: 1 } };

    mountStore({ name: 'app' });
    await vi.advanceTimersByTimeAsync(10);

    expect(storage['app::vault']).toBe('sealed');
    expect(storage['app::__index']).toEqual(['vault', 'subnets']);
    expect(storage.app).toBeUndefined();
  });

  it('falls back to the previous copy when a slice named by the index is gone', async () => {
    storage.app = { vault: 'sealed', subnets: { 1: 1 } };
    storage['app::__index'] = ['vault', 'subnets'];
    storage['app::vault'] = 'sealed';
    // `app::subnets` never landed.

    const store = mountStore({ name: 'app' });
    await vi.advanceTimersByTimeAsync(10);

    expect(store.getState().subnets).toEqual({ 1: 1 });
    expect(store.getState().vault).toBe('sealed');
  });

  it('cleans up a previous copy left by an interrupted migration', async () => {
    storage.app = { vault: 'stale', subnets: { 9: 9 } };
    storage['app::__index'] = ['vault', 'subnets'];
    storage['app::vault'] = 'current';
    storage['app::subnets'] = { 1: 1 };

    const store = mountStore({ name: 'app' });
    await vi.advanceTimersByTimeAsync(10);

    // The slice layout is the newer one and read cleanly, so the leftover goes.
    expect(store.getState().vault).toBe('current');
    expect(storage.app).toBeUndefined();
  });

  it('retries a slice whose write failed instead of assuming it landed', async () => {
    const store = mountStore({ name: 'app' });
    await vi.advanceTimersByTimeAsync(10);

    failWrites = true;
    store.setState({ vault: 'unsealed' });
    await vi.advanceTimersByTimeAsync(600);
    expect(storage['app::vault']).toBe('sealed');

    // The baseline must not have advanced, or this change would be skipped as
    // already persisted and the slice would stay stale forever.
    failWrites = false;
    store.setState({ vault: 'unsealed-again' });
    await vi.advanceTimersByTimeAsync(600);
    expect(storage['app::vault']).toBe('unsealed-again');
  });
});
