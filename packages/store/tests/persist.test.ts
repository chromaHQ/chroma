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
let set: ReturnType<typeof vi.fn>;
let remove: ReturnType<typeof vi.fn>;
let storage: Record<string, unknown>;

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

  set = vi.fn((items: Record<string, unknown>, callback?: () => void) => {
    Object.assign(storage, items);
    callback?.();
  });
  remove = vi.fn((keys: string[], callback?: () => void) => {
    for (const key of keys) delete storage[key];
    callback?.();
  });

  globalThis.chrome = {
    runtime: {},
    storage: {
      local: {
        get: (keys: string[] | null, callback: (result: Record<string, unknown>) => void) => {
          if (keys === null) return callback({ ...storage });
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
