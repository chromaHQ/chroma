/**
 * @fileoverview Every broadcast is structure-cloned once per connected port, so
 * a context that receives data it never reads still pays for it. These tests
 * cover the per-port topic registry that lets a producer send each port only
 * what it asked for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeRuntimeManager } from '../src/runtime/BridgeRuntime';

const originalChrome = globalThis.chrome;

interface FakePort {
  name: string;
  sender: { id: string };
  postMessage: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (message: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  emit: (message: unknown) => void;
  disconnect: () => void;
}

function createPort(name = 'chroma-bridge'): FakePort {
  const messageListeners: ((message: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];

  return {
    name,
    sender: { id: 'test-extension' },
    postMessage: vi.fn(),
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
    emit: (message) => messageListeners.forEach((fn) => fn(message)),
    disconnect: () => disconnectListeners.forEach((fn) => fn()),
  };
}

let connectPort: (port: FakePort) => void;
let runtime: BridgeRuntimeManager;

beforeEach(() => {
  globalThis.chrome = {
    runtime: {
      id: 'test-extension',
      onConnect: {
        addListener: (fn: (port: chrome.runtime.Port) => void) => {
          connectPort = fn as unknown as (port: FakePort) => void;
        },
      },
      onMessage: { addListener: vi.fn() },
    },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
  } as never;

  runtime = new BridgeRuntimeManager({ container: {} as never });
  runtime.initialize();
});

afterEach(() => {
  globalThis.chrome = originalChrome;
  vi.restoreAllMocks();
});

/** Payload of the single broadcast delivered to a port. */
function payloadSentTo(port: FakePort) {
  expect(port.postMessage).toHaveBeenCalledTimes(1);
  return (port.postMessage.mock.calls[0][0] as { payload: unknown }).payload;
}

describe('BridgeRuntimeManager topic scoping', () => {
  it('sends a port only what its topics cover', () => {
    const scoped = createPort();
    const other = createPort();
    connectPort(scoped);
    connectPort(other);

    scoped.emit({ type: 'topics', topics: ['wallets'] });

    runtime.broadcastScoped('state', (topics) =>
      topics ? [...topics].join(',') : 'everything',
    );

    expect(payloadSentTo(scoped)).toBe('wallets');
    // A port that never registered keeps receiving the unscoped payload.
    expect(payloadSentTo(other)).toBe('everything');
  });

  it('skips a port the producer has nothing to say to', () => {
    const port = createPort();
    connectPort(port);
    port.emit({ type: 'topics', topics: ['wallets'] });

    runtime.broadcastScoped('state', () => undefined);

    expect(port.postMessage).not.toHaveBeenCalled();
  });

  it('replaces a previous registration rather than accumulating', () => {
    const port = createPort();
    connectPort(port);

    port.emit({ type: 'topics', topics: ['wallets'] });
    port.emit({ type: 'topics', topics: ['subnets'] });

    runtime.broadcastScoped('state', (topics) => [...(topics ?? [])].join(','));

    expect(payloadSentTo(port)).toBe('subnets');
  });

  it('forgets a port once it disconnects', () => {
    const port = createPort();
    connectPort(port);
    port.emit({ type: 'topics', topics: ['wallets'] });
    port.disconnect();

    runtime.broadcastScoped('state', () => 'anything');

    expect(port.postMessage).not.toHaveBeenCalled();
  });

  it('leaves plain broadcast delivering to everyone', () => {
    const scoped = createPort();
    connectPort(scoped);
    scoped.emit({ type: 'topics', topics: ['wallets'] });

    runtime.broadcast('state', 'full');

    expect(payloadSentTo(scoped)).toBe('full');
  });
});
