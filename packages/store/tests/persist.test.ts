/**
 * @fileoverview Persistence writes the whole state to `chrome.storage.local` on
 * a debounce. These tests cover the two ways that gets expensive: writing data
 * that never needed persisting, and rewriting bytes that did not change.
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

function mountStore(options: Parameters<typeof chromeStoragePersist>[0]) {
  return createStore<TestState>(
    chromeStoragePersist<TestState>(options)(() => ({
      vault: 'sealed',
      subnets: { 1: 1 },
    })),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  set = vi.fn((_items: Record<string, unknown>, callback?: () => void) => callback?.());

  globalThis.chrome = {
    runtime: {},
    storage: {
      local: {
        get: (_keys: string[], callback: (result: Record<string, unknown>) => void) =>
          callback({}),
        set,
      },
    },
  } as never;
});

afterEach(() => {
  globalThis.chrome = originalChrome;
  vi.useRealTimers();
});

describe('chromeStoragePersist', () => {
  it('writes only what partialize selects', async () => {
    const store = mountStore({
      name: 'app',
      // `subnets` is a refetchable catalog; persisting it costs quota and I/O
      // for data the next boot would replace anyway.
      partialize: ({ subnets: _subnets, ...persisted }: TestState) => persisted,
    });

    await vi.advanceTimersByTimeAsync(10);
    set.mockClear();

    store.setState({ vault: 'unsealed' });
    await vi.advanceTimersByTimeAsync(600);

    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][0].app).toEqual({ vault: 'unsealed' });
  });

  it('skips the write when nothing persisted actually changed', async () => {
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

  it('persists the full state when no partialize is configured', async () => {
    const store = mountStore({ name: 'app' });

    await vi.advanceTimersByTimeAsync(10);
    set.mockClear();

    store.setState({ vault: 'unsealed' });
    await vi.advanceTimersByTimeAsync(600);

    expect(set.mock.calls[0][0].app).toEqual({ vault: 'unsealed', subnets: { 1: 1 } });
  });
});
