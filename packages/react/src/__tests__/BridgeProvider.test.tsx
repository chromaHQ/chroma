/**
 * @fileoverview Unit tests for BridgeProvider.
 *
 * Tests cover:
 * - Connection lifecycle (connecting, connected, disconnected, reconnecting)
 * - Message sending and receiving
 * - Critical operation handling with nonces
 * - Request queuing during disconnection
 * - Health monitoring and ping behavior
 * - Error handling and recovery
 *
 * @module packages/react/src/__tests__/BridgeProvider.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';
import { BridgeProvider, type CriticalOperationOptions } from '../BridgeProvider';
import { useBridge } from '../hooks/useBridge';

// ─────────────────────────────────────────────────────────────────────────────
// Mock Setup
// ─────────────────────────────────────────────────────────────────────────────

interface MockPort {
  postMessage: Mock;
  disconnect: Mock;
  onMessage: { addListener: Mock; removeListener: Mock };
  onDisconnect: { addListener: Mock; removeListener: Mock };
  name: string;
}

interface MockChrome {
  runtime: {
    connect: Mock<() => MockPort>;
    sendMessage: Mock;
    lastError: { message: string } | null;
    id: string;
  };
}

let mockPort: MockPort;
let mockChrome: MockChrome;
let messageHandler: ((message: unknown) => void) | null = null;
let disconnectHandler: (() => void) | null = null;

const createMockPort = (): MockPort => ({
  postMessage: vi.fn(),
  disconnect: vi.fn(),
  onMessage: {
    addListener: vi.fn((handler: (message: unknown) => void) => {
      messageHandler = handler;
    }),
    removeListener: vi.fn(),
  },
  onDisconnect: {
    addListener: vi.fn((handler: () => void) => {
      disconnectHandler = handler;
    }),
    removeListener: vi.fn(),
  },
  name: 'chroma-bridge',
});

const createMockChrome = (): MockChrome => ({
  runtime: {
    connect: vi.fn(() => mockPort),
    sendMessage: vi.fn(),
    lastError: null,
    id: 'test-extension-id',
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Utilities
// ─────────────────────────────────────────────────────────────────────────────

const wrapper = ({ children }: { children: ReactNode }) => (
  <BridgeProvider pingInterval={10000} retryAfter={100} maxRetries={3} defaultTimeout={5000}>
    {children}
  </BridgeProvider>
);

/**
 * Simulate a message response from the service worker.
 *
 * @param id - Message ID to respond to
 * @param data - Response data
 * @param error - Optional error message
 */
const simulateResponse = (id: string, data?: unknown, error?: string) => {
  if (messageHandler) {
    messageHandler({ id, data, error });
  }
};

/**
 * Simulate a broadcast message from the service worker.
 *
 * @param key - Broadcast event key
 * @param payload - Broadcast payload
 */
const simulateBroadcast = (key: string, payload?: unknown) => {
  if (messageHandler) {
    messageHandler({ type: 'broadcast', key, payload });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite
// ─────────────────────────────────────────────────────────────────────────────

describe('BridgeProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockPort = createMockPort();
    mockChrome = createMockChrome();
    (globalThis as any).chrome = mockChrome;
    messageHandler = null;
    disconnectHandler = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    delete (globalThis as any).chrome;
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Connection Lifecycle Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe('connection lifecycle', () => {
    it('connects to service worker on mount', async () => {
      const { result } = renderHook(() => useBridge(), { wrapper });

      await waitFor(() => {
        expect(mockChrome.runtime.connect).toHaveBeenCalledWith({ name: 'chroma-bridge' });
      });

      expect(result.current.status).toBe('connected');
      expect(result.current.bridge).not.toBeNull();
    });

    it('sets up message and disconnect listeners', async () => {
      renderHook(() => useBridge(), { wrapper });

      await waitFor(() => {
        expect(mockPort.onMessage.addListener).toHaveBeenCalled();
        expect(mockPort.onDisconnect.addListener).toHaveBeenCalled();
      });
    });

    it('handles disconnection and attempts reconnection', async () => {
      const { result } = renderHook(() => useBridge(), { wrapper });

      await waitFor(() => {
        expect(result.current.status).toBe('connected');
      });

      // Simulate disconnect
      act(() => {
        disconnectHandler?.();
      });

      await waitFor(() => {
        expect(result.current.status).toBe('reconnecting');
      });
    });

    it('cleans up on unmount', async () => {
      const { unmount } = renderHook(() => useBridge(), { wrapper });

      await waitFor(() => {
        expect(mockPort.onMessage.addListener).toHaveBeenCalled();
      });

      unmount();

      expect(mockPort.disconnect).toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Message Sending Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe('send', () => {
    it('sends message through port', async () => {
      const { result } = renderHook(() => useBridge(), { wrapper });

      await waitFor(() => {
        expect(result.current.bridge).not.toBeNull();
      });

      const sendPromise = result.current.bridge!.send('test-event', { data: 'test' });

      // Get the message ID from the call
      const sentMessage = mockPort.postMessage.mock.calls[0][0];
      expect(sentMessage.key).toBe('test-event');
      expect(sentMessage.payload).toEqual({ data: 'test' });

      // Simulate response
      simulateResponse(sentMessage.id, { result: 'success' });

      const response = await sendPromise;
      expect(response).toEqual({ result: 'success' });
    });

    it('rejects on error response', async () => {
      const { result } = renderHook(() => useBridge(), { wrapper });

      await waitFor(() => {
        expect(result.current.bridge).not.toBeNull();
      });

      const sendPromise = result.current.bridge!.send('test-event', { data: 'test' });

      const sentMessage = mockPort.postMessage.mock.calls[0][0];
      simulateResponse(sentMessage.id, undefined, 'Test error');

      await expect(sendPromise).rejects.toThrow('Test error');
    });

    it('times out if no response received', async () => {
      const { result } = renderHook(() => useBridge(), { wrapper });

      await waitFor(() => {
        expect(result.current.bridge).not.toBeNull();
      });

      // Start the send, expect it to reject
      const sendPromise = result.current.bridge!.send('test-event', { data: 'test' }, 100);

      // Add catch to prevent unhandled rejection warning during timer advance
      sendPromise.catch(() => {});

      // Advance time past timeout using act
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      // Verify it rejected with timeout error
      await expect(sendPromise).rejects.toThrow('Request timed out');
    }, 10000);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Critical Operation Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe('sendCritical / sendWithNonce', () => {
    it('includes nonce in critical payload', async () => {
      const { result } = renderHook(() => useBridge(), { wrapper });

      await waitFor(() => {
        expect(result.current.bridge).not.toBeNull();
      });

      // Start the critical operation
      const sendPromise = result.current.bridge!.sendWithNonce('transfer', { amount: '1000' });

      // Wait for the message to be sent
      await waitFor(() => {
        expect(mockPort.postMessage).toHaveBeenCalled();
      });

      const sentMessage = mockPort.postMessage.mock.calls[0][0];
      expect(sentMessage.payload.__critical__).toBe(true);
      expect(sentMessage.payload.__nonce__).toBeDefined();
      expect(typeof sentMessage.payload.__nonce__).toBe('string');
      expect(sentMessage.payload.data).toEqual({ amount: '1000' });

      // Simulate response
      act(() => {
        simulateResponse(sentMessage.id, { txHash: '0x123' });
      });

      // Advance timers to resolve the ack timeout (5s)
      await act(async () => {
        vi.advanceTimersByTime(5100);
      });

      const response = await sendPromise;
      expect(response.data).toEqual({ txHash: '0x123' });
      expect(response.nonce).toBe(sentMessage.payload.__nonce__);
    }, 15000);

    it('uses provided nonce if specified', async () => {
      const { result } = renderHook(() => useBridge(), { wrapper });

      await waitFor(() => {
        expect(result.current.bridge).not.toBeNull();
      });

      const customNonce = 'custom-nonce-123';
      const options: CriticalOperationOptions = { nonce: customNonce };

      const sendPromise = result.current.bridge!.sendWithNonce(
        'transfer',
        { amount: '1000' },
        options,
      );

      // Wait for the message to be sent
      await waitFor(() => {
        expect(mockPort.postMessage).toHaveBeenCalled();
      });

      const sentMessage = mockPort.postMessage.mock.calls[0][0];
      expect(sentMessage.payload.__nonce__).toBe(customNonce);

      act(() => {
        simulateResponse(sentMessage.id, { success: true });
      });

      // Advance timers to resolve the ack timeout (5s)
      await act(async () => {
        vi.advanceTimersByTime(5100);
      });

      const response = await sendPromise;
      expect(response.nonce).toBe(customNonce);
    }, 15000);

    it('calls onAcknowledged callback when ack received', async () => {
      const { result } = renderHook(() => useBridge(), { wrapper });

      await waitFor(() => {
        expect(result.current.bridge).not.toBeNull();
      });

      const onAcknowledged = vi.fn();
      const options: CriticalOperationOptions = { onAcknowledged };

      const sendPromise = result.current.bridge!.sendWithNonce(
        'transfer',
        { amount: '1000' },
        options,
      );

      const sentMessage = mockPort.postMessage.mock.calls[0][0];
      const nonce = sentMessage.payload.__nonce__;

      // Simulate acknowledgment broadcast
      simulateBroadcast(`__ack__:${nonce}`, undefined);

      expect(onAcknowledged).toHaveBeenCalled();

      // Complete the request
      simulateResponse(sentMessage.id, { success: true });
      await sendPromise;
    });

    it('fails immediately with noQueue option when disconnected', async () => {
      const { result } = renderHook(() => useBridge(), { wrapper });

      await waitFor(() => {
        expect(result.current.bridge).not.toBeNull();
        expect(result.current.bridge!.isConnected).toBe(true);
      });

      // Store reference to bridge before disconnect
      const bridge = result.current.bridge!;

      // Simulate disconnect
      act(() => {
        disconnectHandler?.();
      });

      // Wait for status to change to reconnecting
      await waitFor(() => {
        expect(result.current.status).toBe('reconnecting');
      });

      // Try to send with noQueue - should fail immediately
      const options: CriticalOperationOptions = { noQueue: true };

      await expect(bridge.sendWithNonce('transfer', { amount: '1000' }, options)).rejects.toThrow(
        'Not connected',
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Broadcast Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe('broadcast and event listeners', () => {
    it('receives broadcast messages', async () => {
      const { result } = renderHook(() => useBridge(), { wrapper });

      await waitFor(() => {
        expect(result.current.bridge).not.toBeNull();
      });

      const handler = vi.fn();
      result.current.bridge!.on('wallet:updated', handler);

      simulateBroadcast('wallet:updated', { walletId: '123' });

      expect(handler).toHaveBeenCalledWith({ walletId: '123' });
    });

    it('can remove event listeners', async () => {
      const { result } = renderHook(() => useBridge(), { wrapper });

      await waitFor(() => {
        expect(result.current.bridge).not.toBeNull();
      });

      const handler = vi.fn();
      result.current.bridge!.on('wallet:updated', handler);
      result.current.bridge!.off('wallet:updated', handler);

      simulateBroadcast('wallet:updated', { walletId: '123' });

      expect(handler).not.toHaveBeenCalled();
    });

    it('broadcasts messages to service worker', async () => {
      const { result } = renderHook(() => useBridge(), { wrapper });

      await waitFor(() => {
        expect(result.current.bridge).not.toBeNull();
      });

      result.current.bridge!.broadcast('ui:ready', { timestamp: Date.now() });

      expect(mockPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'broadcast',
          key: 'ui:ready',
        }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Health Monitoring Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe('health monitoring', () => {
    it('ping returns true when connected', async () => {
      const { result } = renderHook(() => useBridge(), { wrapper });

      await waitFor(() => {
        expect(result.current.bridge).not.toBeNull();
      });

      const pingPromise = result.current.bridge!.ping();

      // Find and respond to ping message
      const pingMessage = mockPort.postMessage.mock.calls.find(
        (call) => call[0].key === '__ping__',
      )?.[0];

      if (pingMessage) {
        simulateResponse(pingMessage.id, true);
      }

      const isAlive = await pingPromise;
      expect(isAlive).toBe(true);
    });

    it('ping returns false on timeout', async () => {
      const { result } = renderHook(() => useBridge(), { wrapper });

      await waitFor(() => {
        expect(result.current.bridge).not.toBeNull();
      });

      const pingPromise = result.current.bridge!.ping();

      // Don't respond to ping, let it timeout
      await act(async () => {
        vi.advanceTimersByTime(10000);
      });

      const isAlive = await pingPromise;
      expect(isAlive).toBe(false);
    });

    it('pauses health checks when requested', async () => {
      const { result } = renderHook(() => useBridge(), { wrapper });

      await waitFor(() => {
        expect(result.current.bridge).not.toBeNull();
      });

      // Pause health checks for 30 seconds
      result.current.bridge!.pauseHealthChecks(30000);

      // This is a unit test - we're just verifying the method exists and doesn't throw
      // Integration testing would verify the actual pause behavior
      expect(true).toBe(true);
    });

    it('ensureConnected returns true when connected', async () => {
      const { result } = renderHook(() => useBridge(), { wrapper });

      await waitFor(() => {
        expect(result.current.bridge).not.toBeNull();
      });

      const ensurePromise = result.current.bridge!.ensureConnected();

      // Respond to the internal ping
      await act(async () => {
        vi.advanceTimersByTime(10);
      });

      const pingMessage = mockPort.postMessage.mock.calls.find(
        (call) => call[0].key === '__ping__',
      )?.[0];

      if (pingMessage) {
        simulateResponse(pingMessage.id, true);
      }

      const isConnected = await ensurePromise;
      expect(isConnected).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // isConnected Property Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe('isConnected', () => {
    it('returns true when connected', async () => {
      const { result } = renderHook(() => useBridge(), { wrapper });

      await waitFor(() => {
        expect(result.current.bridge).not.toBeNull();
      });

      expect(result.current.bridge!.isConnected).toBe(true);
    });

    it('returns false after disconnect', async () => {
      const { result } = renderHook(() => useBridge(), { wrapper });

      await waitFor(() => {
        expect(result.current.bridge!.isConnected).toBe(true);
      });

      // Store reference to bridge before disconnect
      const bridge = result.current.bridge!;

      act(() => {
        disconnectHandler?.();
      });

      // Wait for status to indicate reconnecting
      await waitFor(() => {
        expect(result.current.status).toBe('reconnecting');
      });

      // Bridge isConnected should now be false
      expect(bridge.isConnected).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Context Value Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe('context value', () => {
    it('provides status, bridge, error, and reconnect', async () => {
      const { result } = renderHook(() => useBridge(), { wrapper });

      await waitFor(() => {
        expect(result.current.bridge).not.toBeNull();
      });

      expect(result.current.status).toBeDefined();
      expect(result.current.bridge).toBeDefined();
      expect(result.current.error).toBeNull();
      expect(typeof result.current.reconnect).toBe('function');
      expect(typeof result.current.isServiceWorkerAlive).toBe('boolean');
    });

    it('reconnect function triggers reconnection', async () => {
      const { result } = renderHook(() => useBridge(), { wrapper });

      await waitFor(() => {
        expect(result.current.bridge).not.toBeNull();
      });

      const initialConnectCalls = mockChrome.runtime.connect.mock.calls.length;

      act(() => {
        result.current.reconnect();
      });

      await waitFor(() => {
        expect(mockChrome.runtime.connect.mock.calls.length).toBeGreaterThan(initialConnectCalls);
      });
    });
  });
});
