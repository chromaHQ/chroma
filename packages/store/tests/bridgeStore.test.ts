/**
 * @fileoverview The bridge store mirrors service-worker state into another
 * context. These tests pin the properties that decide how much work that
 * mirroring costs downstream: unchanged slices keep their identity, no-op
 * broadcasts notify nobody, and batching never silently drops a delta.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeStore, type BridgeWithEvents } from '../src/bridge';
import { createStateDelta } from '../src/stateDelta';

interface TestState extends Record<string, unknown> {
  wallets: Record<string, number>;
  subnets: Record<string, { price: number }>;
}

function createFakeBridge(initialState: TestState) {
  const handlers = new Map<string, ((payload: unknown) => void)[]>();
  const send = vi.fn(async (key: string) => {
    if (key.endsWith(':getState')) {
      // Deserialization on the real bridge produces a fresh object graph every
      // time; the fake must do the same or the tests prove nothing.
      return structuredClone(send.state);
    }
    return undefined;
  }) as ReturnType<typeof vi.fn> & { state: TestState };

  send.state = initialState;

  const bridge: BridgeWithEvents = {
    send: send as never,
    isConnected: true,
    on: (key, handler) => {
      handlers.set(key, [...(handlers.get(key) ?? []), handler]);
    },
    off: (key, handler) => {
      handlers.set(key, (handlers.get(key) ?? []).filter((entry) => entry !== handler));
    },
  };

  return {
    bridge,
    send,
    emit(key: string, payload: unknown) {
      for (const handler of handlers.get(key) ?? []) handler(payload);
    },
  };
}

const STATE_CHANGED = 'store:test:stateChanged';

let harness: ReturnType<typeof createFakeBridge>;
let store: BridgeStore<TestState>;

async function createStore(initialState: TestState) {
  harness = createFakeBridge(initialState);
  store = new BridgeStore<TestState>(harness.bridge, undefined, 'test');
  // Let the constructor's initialize() round-trip settle.
  await vi.waitFor(() => expect(store.getState()).toBeTruthy());
  return store;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  store?.destroy();
  vi.useRealTimers();
});

describe('BridgeStore state application', () => {
  it('notifies subscribers once the first state arrives', async () => {
    await createStore({ wallets: { a: 1 }, subnets: {} });

    const listener = vi.fn();
    store.subscribe(listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].wallets).toEqual({ a: 1 });
  });

  it('keeps identities for slices a broadcast did not change', async () => {
    await createStore({ wallets: { a: 1 }, subnets: { 1: { price: 1 } } });
    const before = store.getState();

    harness.emit(
      STATE_CHANGED,
      createStateDelta(null, structuredClone({ ...before, subnets: { 1: { price: 2 } } }), 0),
    );
    await vi.advanceTimersByTimeAsync(100);

    const after = store.getState();
    expect(after).not.toBe(before);
    // The whole point: an unrelated slice must not invalidate selectors.
    expect(after.wallets).toBe(before.wallets);
    expect(after.subnets).not.toBe(before.subnets);
    expect(after.subnets[1].price).toBe(2);
  });

  it('does not notify when a broadcast carries no actual change', async () => {
    await createStore({ wallets: { a: 1 }, subnets: {} });

    const listener = vi.fn();
    store.subscribe(listener);
    listener.mockClear();

    harness.emit(STATE_CHANGED, createStateDelta(null, structuredClone(store.getState()), 0));
    await vi.advanceTimersByTimeAsync(100);

    expect(listener).not.toHaveBeenCalled();
  });

  it('merges every delta in a batch instead of keeping only the last', async () => {
    await createStore({ wallets: { a: 1 }, subnets: { 1: { price: 1 } } });

    // Two deltas inside one debounce window, each touching a different slice.
    harness.emit(STATE_CHANGED, {
      __chromaStateDelta: true,
      changed: { wallets: { a: 2 } },
      sequence: 0,
    });
    harness.emit(STATE_CHANGED, {
      __chromaStateDelta: true,
      changed: { subnets: { 1: { price: 5 } } },
      sequence: 1,
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(store.getState().wallets).toEqual({ a: 2 });
    expect(store.getState().subnets).toEqual({ 1: { price: 5 } });
  });

  it('refetches the full state when a broadcast was missed', async () => {
    await createStore({ wallets: { a: 1 }, subnets: {} });

    harness.emit(STATE_CHANGED, {
      __chromaStateDelta: true,
      changed: { wallets: { a: 2 } },
      sequence: 0,
    });
    await vi.advanceTimersByTimeAsync(100);
    harness.send.mockClear();

    // Sequence 2 arrives while 1 was expected: merging would leave the store
    // silently missing whatever sequence 1 carried.
    harness.send.state = { wallets: { a: 9 }, subnets: { 3: { price: 3 } } };
    harness.emit(STATE_CHANGED, {
      __chromaStateDelta: true,
      changed: { subnets: { 3: { price: 3 } } },
      sequence: 2,
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.send).toHaveBeenCalledWith('store:test:getState');
    expect(store.getState().wallets).toEqual({ a: 9 });
  });

  it('still accepts a whole-state payload', async () => {
    await createStore({ wallets: { a: 1 }, subnets: {} });

    harness.emit(STATE_CHANGED, { wallets: { a: 7 }, subnets: {} });
    await vi.advanceTimersByTimeAsync(100);

    expect(store.getState().wallets).toEqual({ a: 7 });
  });

  it('flushes a batch that keeps being extended past the max wait', async () => {
    await createStore({ wallets: { a: 0 }, subnets: {} });

    const listener = vi.fn();
    store.subscribe(listener);
    listener.mockClear();

    // A write every 40ms never lets a 50ms trailing debounce expire.
    for (let index = 1; index <= 12; index += 1) {
      harness.emit(STATE_CHANGED, {
        __chromaStateDelta: true,
        changed: { wallets: { a: index } },
        sequence: index - 1,
      });
      await vi.advanceTimersByTimeAsync(40);
    }

    expect(listener).toHaveBeenCalled();
  });
});

describe('BridgeStore scoped subscriptions', () => {
  it('registers the slices selectors actually read', async () => {
    const setTopics = vi.fn();
    harness = createFakeBridge({ wallets: { a: 1 }, subnets: { 1: { price: 1 } } });
    harness.bridge.setTopics = setTopics;
    store = new BridgeStore<TestState>(harness.bridge, undefined, 'test');
    await vi.waitFor(() => expect(store.getState()).toBeTruthy());

    setTopics.mockClear();
    // A selector reading one slice should not subscribe this context to the rest.
    void store.getState().wallets;
    await vi.advanceTimersByTimeAsync(100);

    expect(setTopics).toHaveBeenCalledTimes(1);
    const registered = setTopics.mock.calls[0][0] as string[];
    expect(registered).toContain('store:test:__scoped__');
    expect(registered).toContain('store:test:slice:wallets');
    expect(registered).not.toContain('store:test:slice:subnets');
  });

  it('resynchronizes when a newly read slice widens the scope', async () => {
    const setTopics = vi.fn();
    harness = createFakeBridge({ wallets: { a: 1 }, subnets: { 1: { price: 1 } } });
    harness.bridge.setTopics = setTopics;
    store = new BridgeStore<TestState>(harness.bridge, undefined, 'test');
    await vi.waitFor(() => expect(store.getState()).toBeTruthy());

    void store.getState().wallets;
    await vi.advanceTimersByTimeAsync(100);
    harness.send.mockClear();

    // Until now the worker was filtering `subnets` out, so whatever is held for
    // it may be stale and has to be refetched rather than trusted.
    void store.getState().subnets;
    await vi.advanceTimersByTimeAsync(100);

    expect(setTopics.mock.calls.at(-1)![0]).toContain('store:test:slice:subnets');
    expect(harness.send).toHaveBeenCalledWith('store:test:getState');
  });

  it('does not track or register when the bridge cannot scope', async () => {
    await createStore({ wallets: { a: 1 }, subnets: {} });

    // No setTopics on the bridge: reads stay untracked and state is returned raw.
    expect(store.getState()).toBe(store.getState());
    void store.getState().wallets;
    await vi.advanceTimersByTimeAsync(100);

    expect(store.getState().wallets).toEqual({ a: 1 });
  });

  it('re-registers scope on reconnect, before asking for state', async () => {
    const setTopics = vi.fn();
    harness = createFakeBridge({ wallets: { a: 1 }, subnets: {} });
    harness.bridge.setTopics = setTopics;
    store = new BridgeStore<TestState>(harness.bridge, undefined, 'test');
    await vi.waitFor(() => expect(store.getState()).toBeTruthy());

    void store.getState().wallets;
    await vi.advanceTimersByTimeAsync(100);
    setTopics.mockClear();

    // A reconnect means a fresh port, which has no record of this context.
    harness.emit('bridge:connected', {});
    await vi.advanceTimersByTimeAsync(100);

    expect(setTopics).toHaveBeenCalled();
    expect(setTopics.mock.calls[0][0]).toContain('store:test:slice:wallets');
  });
});
