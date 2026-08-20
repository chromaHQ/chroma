/**
 * @fileoverview Persistence holds the only copy of data a user cannot
 * regenerate, so these tests are weighted toward what happens when storage
 * misbehaves — and especially toward the migration window, where two copies
 * exist and a wrong move destroys the surviving one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { chromeStoragePersist } from '../src/persist';

interface TestState extends Record<string, unknown> {
  vault: string | null;
  subnets: Record<string, number>;
}

const QUOTA = 10 * 1024 * 1024;

const originalChrome = globalThis.chrome;
let lastError: { message: string } | undefined;
let set: ReturnType<typeof vi.fn>;
let remove: ReturnType<typeof vi.fn>;
let storage: Record<string, unknown>;
/** Injected failures, so the fail-closed paths can be exercised. */
let failWriteWhen: ((items: Record<string, unknown>) => boolean) | null;
let failReadsFor: string | null;
let bytesInUse: number;
/** Silently drops these keys on write, to model a write that reports success. */
let swallowKeys: string[];

function mountStore(options: Parameters<typeof chromeStoragePersist>[0]) {
  return createStore<TestState>(
    chromeStoragePersist<TestState>(options)(() => ({
      vault: 'sealed',
      subnets: { 1: 1 },
    })),
  );
}

/** Settles the load chain, including read retries. */
const settle = () => vi.advanceTimersByTimeAsync(600);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  storage = {};
  failWriteWhen = null;
  failReadsFor = null;
  swallowKeys = [];
  bytesInUse = 1024;
  lastError = undefined;

  set = vi.fn((items: Record<string, unknown>, callback?: () => void) => {
    if (failWriteWhen?.(items)) {
      lastError = { message: 'QUOTA_BYTES quota exceeded' };
      callback?.();
      lastError = undefined;
      return;
    }
    for (const [k, v] of Object.entries(items)) {
      if (!swallowKeys.includes(k)) storage[k] = v;
    }
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
        QUOTA_BYTES: QUOTA,
        getBytesInUse: (_keys: null, cb: (bytes: number) => void) => cb(bytesInUse),
        get: (keys: string[], callback: (result: Record<string, unknown>) => void) => {
          if (failReadsFor && keys.includes(failReadsFor)) {
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

/** A pre-migration install. */
function seedBlob(state: Partial<TestState> = { vault: 'sealed', subnets: { 1: 1 } }) {
  storage.app = state;
}

/** A migrated install. */
function seedSlices(state: Record<string, unknown>) {
  storage['app::__layout'] = 'slices';
  storage['app::__index'] = Object.keys(state);
  for (const [slice, value] of Object.entries(state)) {
    storage[`app::${slice}`] = value;
  }
}

describe('migration to the slice layout', () => {
  it('writes, verifies, commits the marker, then removes the blob', async () => {
    seedBlob();
    mountStore({ name: 'app' });
    await settle();

    expect(storage['app::vault']).toBe('sealed');
    expect(storage['app::__index']).toEqual(['vault', 'subnets']);
    expect(storage['app::__layout']).toBe('slices');
    // Removed last, and only after the replacement read back identical.
    expect(storage.app).toBeUndefined();
  });

  it('does not start when a second copy would not fit under the quota', async () => {
    seedBlob();
    bytesInUse = QUOTA * 0.95;

    const store = mountStore({ name: 'app' });
    await settle();

    // The doubling window is where a large store runs out of room, and a
    // partial write there is what destroys the surviving copy.
    expect(storage.app).toEqual({ vault: 'sealed', subnets: { 1: 1 } });
    expect(storage['app::__layout']).toBeUndefined();
    expect(store.getState().vault).toBe('sealed');
  });

  it('keeps the blob when the slice write does not land', async () => {
    seedBlob();
    failWriteWhen = (items) => 'app::vault' in items;

    mountStore({ name: 'app' });
    await settle();

    expect(storage.app).toEqual({ vault: 'sealed', subnets: { 1: 1 } });
    expect(storage['app::__layout']).toBeUndefined();
  });

  it('keeps the blob when the slices do not read back identical', async () => {
    seedBlob();
    // Reports success but drops a slice: exactly the case that turns
    // "delete the old copy" into data loss.
    swallowKeys = ['app::subnets'];

    mountStore({ name: 'app' });
    await settle();

    expect(storage.app).toEqual({ vault: 'sealed', subnets: { 1: 1 } });
    expect(storage['app::__layout']).toBeUndefined();
  });

  it('keeps the blob when the layout marker does not land', async () => {
    seedBlob();
    failWriteWhen = (items) => 'app::__layout' in items;

    mountStore({ name: 'app' });
    await settle();

    // Slices exist but were never committed, so they are inert.
    expect(storage.app).toEqual({ vault: 'sealed', subnets: { 1: 1 } });
    expect(storage['app::__layout']).toBeUndefined();
  });

  it('stops retrying a migration that keeps failing', async () => {
    seedBlob();
    storage['app::__migrationAttempts'] = 3;

    mountStore({ name: 'app' });
    await settle();

    expect(set).not.toHaveBeenCalledWith(
      expect.objectContaining({ 'app::vault': expect.anything() }),
      expect.anything(),
    );
    expect(storage.app).toEqual({ vault: 'sealed', subnets: { 1: 1 } });
  });

  it('counts a failed attempt so it eventually gives up', async () => {
    seedBlob();
    failWriteWhen = (items) => 'app::vault' in items;

    mountStore({ name: 'app' });
    await settle();

    expect(storage['app::__migrationAttempts']).toBe(1);
  });
});

describe('reading the authoritative copy', () => {
  it('reads slices when the marker says they are authoritative', async () => {
    seedSlices({ vault: 'from-slices', subnets: { 3: 3 } });

    const store = mountStore({ name: 'app' });
    await settle();

    expect(store.getState().vault).toBe('from-slices');
    expect(store.getState().subnets).toEqual({ 3: 3 });
  });

  it('ignores a stale blob left beside a committed slice layout', async () => {
    seedSlices({ vault: 'current', subnets: { 1: 1 } });
    storage.app = { vault: 'stale', subnets: { 9: 9 } };

    const store = mountStore({ name: 'app' });
    await settle();

    // The marker removes any question of which copy is newer.
    expect(store.getState().vault).toBe('current');
  });

  it('falls back to the blob when the slice layout is torn', async () => {
    seedSlices({ vault: 'sealed', subnets: { 1: 1 } });
    delete storage['app::subnets'];
    storage.app = { vault: 'whole', subnets: { 2: 2 } };

    const store = mountStore({ name: 'app' });
    await settle();

    expect(store.getState().vault).toBe('whole');
    expect(store.getState().subnets).toEqual({ 2: 2 });
  });

  it('disables writes when the slice layout is torn and nothing else survives', async () => {
    seedSlices({ vault: 'sealed', subnets: { 1: 1 } });
    delete storage['app::subnets'];

    const store = mountStore({ name: 'app' });
    await settle();
    set.mockClear();

    store.setState({ vault: 'defaults-in-memory' });
    await settle();

    // Replacing a torn layout with slice defaults would finish the job that
    // tore it. Better to render empty and leave the disk alone.
    expect(set).not.toHaveBeenCalled();
    expect(storage['app::vault']).toBe('sealed');
  });

  it('carries forward slices an interim build wrote without a marker', async () => {
    storage['app::__index'] = ['vault', 'subnets'];
    storage['app::vault'] = 'from-interim-build';
    storage['app::subnets'] = { 5: 5 };

    const store = mountStore({ name: 'app' });
    await settle();

    expect(store.getState().vault).toBe('from-interim-build');
  });

  it('never writes after a read it could not complete', async () => {
    seedBlob();
    failReadsFor = 'app';

    const store = mountStore({ name: 'app' });
    await settle();
    set.mockClear();

    store.setState({ vault: 'defaults-in-memory' });
    await settle();

    expect(set).not.toHaveBeenCalled();
    expect(storage.app).toEqual({ vault: 'sealed', subnets: { 1: 1 } });
  });
});

describe('writing after migration', () => {
  it('rewrites only the slice that changed', async () => {
    seedSlices({ vault: 'sealed', subnets: { 1: 1 } });
    const store = mountStore({ name: 'app' });
    await settle();
    set.mockClear();

    store.setState({ vault: 'unsealed' });
    await settle();

    expect(set).toHaveBeenCalledTimes(1);
    expect(Object.keys(set.mock.calls[0][0])).toEqual(['app::vault']);
  });

  it('skips the write when nothing persisted changed', async () => {
    seedSlices({ vault: 'sealed' });
    const store = mountStore({
      name: 'app',
      partialize: ({ subnets: _subnets, ...persisted }: TestState) => persisted,
    });
    await settle();
    set.mockClear();

    store.setState({ subnets: { 1: 2 } });
    await settle();

    expect(set).not.toHaveBeenCalled();
  });

  it('retries a write that failed instead of assuming it landed', async () => {
    seedSlices({ vault: 'sealed', subnets: { 1: 1 } });
    const store = mountStore({ name: 'app' });
    await settle();

    failWriteWhen = () => true;
    store.setState({ vault: 'unsealed' });
    await settle();
    expect(storage['app::vault']).toBe('sealed');

    failWriteWhen = null;
    store.setState({ vault: 'unsealed-again' });
    await settle();
    expect(storage['app::vault']).toBe('unsealed-again');
  });

  it('drops a slice key only after the index stops naming it', async () => {
    seedSlices({ vault: 'sealed', subnets: { 1: 1 } });

    mountStore({
      name: 'app',
      partialize: ({ subnets: _subnets, ...persisted }: TestState) => persisted,
    });
    await settle();

    expect(storage['app::__index']).toEqual(['vault']);
    expect(storage['app::subnets']).toBeUndefined();
  });

  it('writes the initial state when there is nothing stored at all', async () => {
    mountStore({ name: 'app' });
    await settle();

    expect(storage.app).toEqual({ vault: 'sealed', subnets: { 1: 1 } });
  });
});
