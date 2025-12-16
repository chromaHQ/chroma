/**
 * @fileoverview BridgeProvider - React context for Chrome extension bridge communication.
 *
 * Provides a robust, fault-tolerant communication layer between React UI and
 * Chrome extension service worker. Handles connection lifecycle, message routing,
 * automatic reconnection, request queuing, and health monitoring.
 *
 * Key features:
 * - Automatic reconnection with exponential backoff
 * - Request queuing during disconnection for seamless UX
 * - Critical operation support with nonces for idempotency
 * - Health monitoring with configurable ping intervals
 * - Broadcast message support for real-time updates
 *
 * @module @chromahq/react/BridgeProvider
 *
 * @example
 * ```tsx
 * // App setup
 * <BridgeProvider pingInterval={5000} maxRetries={10}>
 *   <App />
 * </BridgeProvider>
 *
 * // Using the bridge
 * const { bridge, status } = useBridge();
 * const result = await bridge.send('transfer', { to: '0x...', amount: '1000' });
 * ```
 */
import {
  useEffect,
  useState,
  createContext,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
  type FC,
  type MutableRefObject,
} from 'react';

// Global bridge logging toggle; wired to Bootstrap.enableLogs at runtime
// Consumers can set `window.__CHROMA_ENABLE_LOGS__ = false` to silence logs
const BRIDGE_ENABLE_LOGS: boolean = true;
const DIRECT_MESSAGE_FLAG = '__CHROMA_BRIDGE_DIRECT_MESSAGE__';

// ============================================================================
// Queued Request Types (for transparent retry)
// ============================================================================

interface QueuedRequest {
  id: string;
  key: string;
  payload: unknown;
  timeoutDuration: number;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  retryCount: number;
  maxRetries: number;
  queuedAt: number;
  idempotencyKey?: string; // For deduplication
}

interface BridgeDiagnosticsSnapshot {
  lastUpdatedAt: number;
  portDisconnects: number;
  lastDisconnectError?: string;
  lastDisconnectAt?: number;
  sendMessageFallbacks: number;
  lastFallbackReason?: string;
  lastFallbackAt?: number;
  sendMessageFallbackErrors: number;
  lastFallbackError?: string;
  pingFailures: number;
  lastPingFailureAt?: number;
}

interface BridgeDiagnosticsApi {
  get: () => BridgeDiagnosticsSnapshot;
  reset: () => void;
}

declare global {
  interface Window {
    __CHROMA_BRIDGE_DIAGNOSTICS__?: BridgeDiagnosticsApi;
  }
}

const createInitialDiagnosticsState = (): BridgeDiagnosticsSnapshot => ({
  lastUpdatedAt: Date.now(),
  portDisconnects: 0,
  lastDisconnectError: undefined,
  lastDisconnectAt: undefined,
  sendMessageFallbacks: 0,
  lastFallbackReason: undefined,
  lastFallbackAt: undefined,
  sendMessageFallbackErrors: 0,
  lastFallbackError: undefined,
  pingFailures: 0,
  lastPingFailureAt: undefined,
});

const bridgeDiagnosticsState: BridgeDiagnosticsSnapshot = createInitialDiagnosticsState();

const updateDiagnosticsState = (mutator: (state: BridgeDiagnosticsSnapshot) => void): void => {
  mutator(bridgeDiagnosticsState);
  bridgeDiagnosticsState.lastUpdatedAt = Date.now();
};

const resetDiagnosticsState = (): void => {
  Object.assign(bridgeDiagnosticsState, createInitialDiagnosticsState());
};

const attachDiagnosticsApi = (): void => {
  if (typeof window === 'undefined') {
    return;
  }

  window.__CHROMA_BRIDGE_DIAGNOSTICS__ = {
    get: () => ({ ...bridgeDiagnosticsState }),
    reset: () => {
      resetDiagnosticsState();
    },
  };
};

attachDiagnosticsApi();

const recordDiagnostics = {
  portDisconnect: (error?: string) => {
    updateDiagnosticsState((state) => {
      state.portDisconnects += 1;
      state.lastDisconnectError = error;
      state.lastDisconnectAt = Date.now();
    });
  },
  fallbackSent: (reason: string) => {
    updateDiagnosticsState((state) => {
      state.sendMessageFallbacks += 1;
      state.lastFallbackReason = reason;
      state.lastFallbackAt = Date.now();
    });
  },
  fallbackError: (error: string) => {
    updateDiagnosticsState((state) => {
      state.sendMessageFallbackErrors += 1;
      state.lastFallbackError = error;
    });
  },
  pingFailure: () => {
    updateDiagnosticsState((state) => {
      state.pingFailures += 1;
      state.lastPingFailureAt = Date.now();
    });
  },
};

// ============================================================================
// Types
// ============================================================================

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error' | 'reconnecting';

/**
 * Options for critical operations that need acknowledgment and deduplication.
 */
export interface CriticalOperationOptions {
  /**
   * Client-generated nonce for idempotency. If not provided, one will be generated.
   * The SW should store processed nonces and reject duplicates.
   */
  nonce?: string;
  /**
   * If true, the request will NOT be queued during disconnection - it will fail immediately.
   * Use this for operations where you want explicit user retry rather than automatic retry.
   * Default: false (requests are queued)
   */
  noQueue?: boolean;
  /**
   * Callback fired when SW acknowledges receipt of the request (before processing).
   * Use this to update UI to show "processing" state.
   */
  onAcknowledged?: () => void;
}

/**
 * Result of a critical operation, including metadata about the request.
 */
export interface CriticalOperationResult<T> {
  data: T;
  nonce: string;
  acknowledged: boolean;
}

interface Bridge {
  send: <Req = unknown, Res = unknown>(
    key: string,
    payload?: Req,
    timeoutDuration?: number,
  ) => Promise<Res>;
  /**
   * Send a critical operation that requires acknowledgment and idempotency.
   * Use this for transfers, signing, and other non-idempotent operations.
   *
   * @example
   * ```ts
   * const result = await bridge.sendCritical('transfer', {
   *   to: '0x...',
   *   amount: '1000000',
   * }, {
   *   onAcknowledged: () => setStatus('processing'),
   *   noQueue: true, // Don't auto-retry transfers
   * });
   * ```
   */
  /** Alias: clearer naming for nonce/idempotency semantics */
  sendWithNonce: <Req = unknown, Res = unknown>(
    key: string,
    payload?: Req,
    options?: CriticalOperationOptions,
    timeoutDuration?: number,
  ) => Promise<CriticalOperationResult<Res>>;
  /** Alias for callers that think in idempotency terms */
  sendIdempotent: <Req = unknown, Res = unknown>(
    key: string,
    payload?: Req,
    options?: CriticalOperationOptions,
    timeoutDuration?: number,
  ) => Promise<CriticalOperationResult<Res>>;
  /** Back-compat name (kept) */
  sendCritical: <Req = unknown, Res = unknown>(
    key: string,
    payload?: Req,
    options?: CriticalOperationOptions,
    timeoutDuration?: number,
  ) => Promise<CriticalOperationResult<Res>>;
  broadcast: (key: string, payload: unknown) => void;
  on: (key: string, handler: (payload: unknown) => void) => void;
  off: (key: string, handler: (payload: unknown) => void) => void;
  isConnected: boolean;
  ping: () => Promise<boolean>;
  /**
   * Pause health checks for the specified duration.
   * Use this before calling a message that triggers heavy/blocking operations in the SW.
   * @param durationMs - How long to pause health checks in milliseconds
   */
  pauseHealthChecks: (durationMs: number) => void;
  /**
   * Ensure the service worker is connected and responsive before performing a heavy operation.
   * This performs a quick ping and returns true if successful.
   * On Windows/Brave, use this before crypto operations to verify the SW hasn't silently restarted.
   *
   * @example
   * ```ts
   * const ready = await bridge.ensureConnected();
   * if (!ready) {
   *   showToast('Connection lost. Please try again.');
   *   return;
   * }
   * bridge.pauseHealthChecks(30000);
   * await bridge.send('unlock', { password });
   * ```
   */
  ensureConnected: () => Promise<boolean>;
}

export interface BridgeContextValue {
  bridge: Bridge | null;
  status: ConnectionStatus;
  error: Error | null;
  reconnect: () => void;
  isServiceWorkerAlive: boolean;
}

interface BridgeProviderProps {
  children: ReactNode;
  /** Base delay for retry attempts in ms. Default: 1000 */
  retryAfter?: number;
  /** Maximum number of retry attempts. Default: 10 */
  maxRetries?: number;
  /** How often to ping the service worker in ms. Default: 5000 */
  pingInterval?: number;
  /** How long to wait before resetting retry count in ms. Default: 30000 */
  maxRetryCooldown?: number;
  /** Default timeout for messages in ms. Default: 30000 */
  defaultTimeout?: number;
  /**
   * Timeout threshold for counting failures toward reconnection.
   * Only requests with timeouts <= this value are counted as potential SW issues.
   * Requests with longer timeouts (intentional slow operations) won't trigger reconnection.
   * Default: 15000 (15s)
   */
  timeoutFailureThreshold?: number;
  /** Callback when connection status changes */
  onConnectionChange?: (status: ConnectionStatus) => void;
  /** Callback when an error occurs */
  onError?: (error: Error) => void;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  timeoutDuration: number; // The timeout duration for this request (used to distinguish slow operations)
  key: string; // Original request key for queue recovery
  payload: unknown; // Original payload for queue recovery
}

interface BridgeMessage {
  id?: string;
  key?: string;
  type?: 'broadcast';
  payload?: unknown;
  data?: unknown;
  error?: string;
}

// ============================================================================
// Constants
// ============================================================================

const CONFIG = {
  RETRY_AFTER: 1000,
  MAX_RETRIES: 10,
  PING_INTERVAL: 5000, // Check every 5s for faster SW down detection
  MAX_RETRY_COOLDOWN: 30000,
  DEFAULT_TIMEOUT: 60000, // 60s default for slow operations
  MAX_RETRY_DELAY: 30000,
  PING_TIMEOUT: 8000, // Give SW 8s to respond to ping (reduced from 20s)
  ERROR_CHECK_INTERVAL: 100,
  MAX_ERROR_CHECKS: 10,
  CONSECUTIVE_FAILURE_THRESHOLD: 2, // Require 2 consecutive failures (~10s total) before reconnecting
  RECONNECT_DELAY: 100,
  PORT_NAME: 'chroma-bridge',
  // Service worker restart retry settings (indefinite retries)
  SW_RESTART_RETRY_DELAY: 500,
  SW_RESTART_MAX_DELAY: 5000,
  // Threshold for counting timeouts toward reconnection (only count fast timeouts as failures)
  // Requests with timeout > this value are considered intentional long operations
  TIMEOUT_FAILURE_THRESHOLD_MS: 30000, // Only count timeouts < 30s as potential SW issues
  // Request queue settings for transparent retry
  REQUEST_QUEUE_MAX_SIZE: 50, // Maximum queued requests during disconnection
  REQUEST_MAX_RETRIES: 3, // Max retries per request before giving up
  REQUEST_RETRY_BASE_DELAY: 200, // Base delay for request retry backoff
  REQUEST_RETRY_MAX_DELAY: 2000, // Max delay for request retry backoff
  QUEUE_DRAIN_DELAY: 50, // Delay between processing queued requests
  // Optimistic health - don't surface unhealthy state immediately
  HEALTH_GRACE_PERIOD_MS: 1000, // Wait this long before showing unhealthy (reduced from 3s)
  // Critical operation settings
  CRITICAL_OP_TIMEOUT: 120000, // 2 minutes for critical operations (transfers, signing)
} as const;

// ============================================================================
// Utilities
// ============================================================================

/** Generate a cryptographically secure nonce for idempotency */
const generateNonce = (): string => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older browsers
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
};

/** Calculate exponential backoff delay with a maximum cap */
const calculateBackoffDelay = (attempt: number, baseDelay: number, maxDelay: number): number =>
  Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);

/** Safely clear a timeout ref */
const clearTimeoutSafe = (ref: MutableRefObject<ReturnType<typeof setTimeout> | null>): void => {
  if (ref.current) {
    clearTimeout(ref.current);
    ref.current = null;
  }
};

/** Safely clear an interval ref */
const clearIntervalSafe = (ref: MutableRefObject<ReturnType<typeof setInterval> | null>): void => {
  if (ref.current) {
    clearInterval(ref.current);
    ref.current = null;
  }
};

/** Consume and return any pending Chrome runtime error */
const consumeRuntimeError = (): string | undefined => {
  const error = chrome.runtime.lastError?.message;
  // Access to clear the error (Chrome requires this)
  void chrome.runtime.lastError;
  return error;
};

// ============================================================================
// Context
// ============================================================================

export const BridgeContext = createContext<BridgeContextValue | null>(null);

// ============================================================================
// Bridge Instance Factory
// ============================================================================

interface BridgeFactoryDeps {
  portRef: MutableRefObject<chrome.runtime.Port | null>;
  portDisconnectedRef: MutableRefObject<boolean>; // Track if port has been disconnected (stale port detection)
  pendingRequestsRef: MutableRefObject<Map<string, PendingRequest>>;
  requestQueueRef: MutableRefObject<QueuedRequest[]>; // Queue for requests during disconnection
  activeIdempotencyKeysRef: MutableRefObject<Set<string>>; // Track in-flight requests for deduplication
  eventListenersRef: MutableRefObject<Map<string, Set<(payload: unknown) => void>>>;
  messageIdRef: MutableRefObject<number>;
  isConnectedRef: MutableRefObject<boolean>;
  isReconnectingRef: MutableRefObject<boolean>; // Track soft reconnection state
  consecutiveTimeoutsRef: MutableRefObject<number>;
  reconnectionGracePeriodRef: MutableRefObject<boolean>;
  healthPausedUntilRef: MutableRefObject<number>;
  defaultTimeout: number;
  timeoutFailureThreshold: number;
  onReconnectNeeded: () => void;
  drainRequestQueue: () => void; // Function to drain queued requests after reconnection
}

function createBridgeInstance(deps: BridgeFactoryDeps): Bridge {
  const {
    portRef,
    portDisconnectedRef,
    pendingRequestsRef,
    requestQueueRef,
    activeIdempotencyKeysRef,
    eventListenersRef,
    messageIdRef,
    isConnectedRef,
    isReconnectingRef,
    consecutiveTimeoutsRef,
    reconnectionGracePeriodRef,
    healthPausedUntilRef,
    defaultTimeout,
    timeoutFailureThreshold,
    onReconnectNeeded,
    drainRequestQueue,
  } = deps;

  /**
   * Check if the port is valid for sending messages.
   * On Windows/Brave, the port object can exist but be stale (SW restarted).
   */
  const isPortValid = (): boolean => {
    // No port at all
    if (!portRef.current) return false;

    // Port was explicitly disconnected (we received onDisconnect)
    if (portDisconnectedRef.current) return false;

    // Not marked as connected by our state machine
    if (!isConnectedRef.current) return false;

    return true;
  };

  /**
   * Generate an idempotency key for request deduplication.
   * This prevents duplicate requests during retries.
   */
  const generateIdempotencyKey = (key: string, payload: unknown): string => {
    // For requests that modify state, use a stable hash
    // For reads, allow duplicates
    const isWriteOperation =
      !key.startsWith('get') && !key.startsWith('fetch') && key !== '__ping__';
    if (!isWriteOperation) return ''; // No deduplication for reads

    try {
      return `${key}:${JSON.stringify(payload)}`;
    } catch {
      return `${key}:${Date.now()}`;
    }
  };

  /**
   * Queue a request for later execution when disconnected.
   * Returns true if queued, false if queue is full.
   */
  const queueRequest = (
    id: string,
    key: string,
    payload: unknown,
    timeoutDuration: number,
    resolve: (data: unknown) => void,
    reject: (error: Error) => void,
    idempotencyKey?: string,
  ): boolean => {
    // Don't queue internal messages
    if (key === '__ping__' || key === '__bridge_diagnostics__') {
      return false;
    }

    // Check queue size limit
    if (requestQueueRef.current.length >= CONFIG.REQUEST_QUEUE_MAX_SIZE) {
      if (BRIDGE_ENABLE_LOGS) {
        console.warn('[Bridge] Request queue full, rejecting request');
      }
      return false;
    }

    // Check for duplicate idempotency key
    if (idempotencyKey && activeIdempotencyKeysRef.current.has(idempotencyKey)) {
      if (BRIDGE_ENABLE_LOGS) {
        console.log(`[Bridge] Duplicate request detected, skipping: ${key}`);
      }
      // Don't reject - the original request will resolve/reject
      return true;
    }

    if (idempotencyKey) {
      activeIdempotencyKeysRef.current.add(idempotencyKey);
    }

    const queuedRequest: QueuedRequest = {
      id,
      key,
      payload,
      timeoutDuration,
      resolve,
      reject,
      retryCount: 0,
      maxRetries: CONFIG.REQUEST_MAX_RETRIES,
      queuedAt: Date.now(),
      idempotencyKey,
    };

    requestQueueRef.current.push(queuedRequest);

    if (BRIDGE_ENABLE_LOGS) {
      console.log(
        `[Bridge] Request queued: ${key} (queue size: ${requestQueueRef.current.length})`,
      );
    }

    return true;
  };

  const rejectAllPending = (message: string) => {
    // Only reject requests with short timeouts (default requests)
    // Long-timeout requests are intentional slow operations and should be allowed to complete
    pendingRequestsRef.current.forEach(({ reject, timeout, timeoutDuration }, id) => {
      if (timeoutDuration <= timeoutFailureThreshold) {
        clearTimeout(timeout);
        reject(new Error(message));
        pendingRequestsRef.current.delete(id);
      }
    });
  };

  const send = <Req, Res = unknown>(
    key: string,
    payload?: Req,
    timeoutDuration: number = defaultTimeout,
  ): Promise<Res> => {
    return new Promise((resolve, reject) => {
      const id = `msg_${++messageIdRef.current}`;
      const idempotencyKey = generateIdempotencyKey(key, payload);

      const finalizePendingWithError = (error: Error | string) => {
        const pending = pendingRequestsRef.current.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        pendingRequestsRef.current.delete(id);
        // Clean up idempotency key
        if (idempotencyKey) {
          activeIdempotencyKeysRef.current.delete(idempotencyKey);
        }
        pending.reject(error instanceof Error ? error : new Error(error));
      };

      /**
       * Fallback to chrome.runtime.sendMessage when port is unavailable.
       * This provides a direct message path that can work even when the port is stale.
       * On Windows/Brave, this is critical for recovering from silent SW restarts.
       */
      const triggerRuntimeFallback = (reason: string, retryCount = 0) => {
        const MAX_FALLBACK_RETRIES = 2;
        const FALLBACK_RETRY_DELAY = 300;

        if (BRIDGE_ENABLE_LOGS) {
          console.warn(
            `[Bridge] Falling back to runtime.sendMessage (${reason})${retryCount > 0 ? ` [retry ${retryCount}]` : ''}`,
          );
        }

        recordDiagnostics.fallbackSent(reason);

        // Only trigger reconnect on first attempt, not on retries
        if (retryCount === 0) {
          onReconnectNeeded();
        }

        if (!chrome?.runtime?.sendMessage) {
          const message = 'chrome.runtime.sendMessage not available';
          recordDiagnostics.fallbackError(message);
          finalizePendingWithError(message);
          return;
        }

        try {
          chrome.runtime.sendMessage(
            {
              id,
              key,
              payload,
              metadata: { transport: 'direct', fallbackReason: reason, retryCount },
              [DIRECT_MESSAGE_FLAG]: true,
            },
            (response: BridgeMessage | undefined) => {
              const runtimeError = consumeRuntimeError();
              const pending = pendingRequestsRef.current.get(id);
              if (!pending) return;

              // On "Receiving end does not exist" errors, retry after a short delay
              // This handles the case where SW is restarting and not yet ready
              if (
                runtimeError?.includes('Receiving end does not exist') &&
                retryCount < MAX_FALLBACK_RETRIES
              ) {
                if (BRIDGE_ENABLE_LOGS) {
                  console.warn(
                    `[Bridge] SW not ready, retrying fallback in ${FALLBACK_RETRY_DELAY}ms...`,
                  );
                }
                setTimeout(() => {
                  triggerRuntimeFallback(reason, retryCount + 1);
                }, FALLBACK_RETRY_DELAY);
                return;
              }

              if (runtimeError) {
                recordDiagnostics.fallbackError(runtimeError);
                clearTimeout(pending.timeout);
                pendingRequestsRef.current.delete(id);
                pending.reject(new Error(runtimeError));
                return;
              }

              if (!response) {
                const message = 'No response from service worker';
                recordDiagnostics.fallbackError(message);
                clearTimeout(pending.timeout);
                pendingRequestsRef.current.delete(id);
                pending.reject(new Error(message));
                return;
              }

              clearTimeout(pending.timeout);
              pendingRequestsRef.current.delete(id);
              consecutiveTimeoutsRef.current = 0;

              if (response.error) {
                recordDiagnostics.fallbackError(response.error);
                pending.reject(new Error(response.error));
              } else {
                pending.resolve(response.data);
              }
            },
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'chrome.runtime.sendMessage failed';
          recordDiagnostics.fallbackError(message);
          finalizePendingWithError(error instanceof Error ? error : new Error(message));
        }
      };

      const timeout = setTimeout(() => {
        if (!pendingRequestsRef.current.has(id)) return;

        pendingRequestsRef.current.delete(id);

        // Only count timeouts toward reconnection if:
        // 1. Not during grace period (SW still starting up)
        // 2. The timeout duration was short (long timeouts are likely intentional slow operations)
        // This prevents false positive disconnections when users have slow storage or heavy operations
        const isShortTimeout = timeoutDuration <= timeoutFailureThreshold;
        if (!reconnectionGracePeriodRef.current && isShortTimeout) {
          consecutiveTimeoutsRef.current++;
        }

        if (BRIDGE_ENABLE_LOGS) {
          console.warn(
            `[Bridge] Request timed out: ${key} (${timeoutDuration}ms)${reconnectionGracePeriodRef.current ? ' [grace period]' : ''}${!isShortTimeout ? ' [long operation, not counted toward reconnect]' : ''}`,
          );
        }

        // Trigger reconnect on consecutive timeouts (but not during grace period)
        // Only if we've had enough SHORT timeouts (indicating actual SW issues, not slow operations)
        if (
          !reconnectionGracePeriodRef.current &&
          isShortTimeout &&
          consecutiveTimeoutsRef.current >= CONFIG.CONSECUTIVE_FAILURE_THRESHOLD
        ) {
          if (BRIDGE_ENABLE_LOGS) {
            console.warn(
              `[Bridge] ${consecutiveTimeoutsRef.current} consecutive timeouts, reconnecting...`,
            );
          }
          rejectAllPending('Bridge reconnecting due to timeouts');
          consecutiveTimeoutsRef.current = 0;
          onReconnectNeeded();
        }

        reject(new Error(`Request timed out: ${key}`));
      }, timeoutDuration);

      pendingRequestsRef.current.set(id, {
        resolve: resolve as (data: unknown) => void,
        reject,
        timeout,
        timeoutDuration,
        key,
        payload,
      });

      // Use improved port validity check instead of just checking portRef.current
      // This catches stale ports on Windows/Brave where the port object exists but is disconnected
      if (!isPortValid()) {
        // If we're actively reconnecting, queue the request for later instead of immediately failing
        // This provides a seamless experience where users don't see errors during brief disconnections
        if (isReconnectingRef.current) {
          // Remove from pending (will be re-added when dequeued)
          clearTimeout(timeout);
          pendingRequestsRef.current.delete(id);

          const queued = queueRequest(
            id,
            key,
            payload,
            timeoutDuration,
            resolve as (data: unknown) => void,
            reject,
            idempotencyKey,
          );

          if (queued) {
            if (BRIDGE_ENABLE_LOGS) {
              console.log(`[Bridge] Request queued during reconnection: ${key}`);
            }
            return;
          }
        }

        // Not reconnecting or queue full - fall back to direct message
        const reason = !portRef.current
          ? 'port-unavailable'
          : portDisconnectedRef.current
            ? 'port-disconnected'
            : 'port-not-connected';
        triggerRuntimeFallback(reason);
        return;
      }

      try {
        portRef.current!.postMessage({ id, key, payload });

        // Check for async runtime errors
        setTimeout(() => {
          const errorMessage = consumeRuntimeError();
          if (errorMessage && pendingRequestsRef.current.has(id)) {
            // On error, try to queue for retry instead of immediately failing
            if (isReconnectingRef.current) {
              const pending = pendingRequestsRef.current.get(id);
              if (pending) {
                clearTimeout(pending.timeout);
                pendingRequestsRef.current.delete(id);

                const queued = queueRequest(
                  id,
                  key,
                  payload,
                  timeoutDuration,
                  pending.resolve,
                  pending.reject,
                  idempotencyKey,
                );

                if (queued) return;
              }
            }
            finalizePendingWithError(errorMessage);
          }
        }, 0);

        // Check for immediate errors
        const immediateError = consumeRuntimeError();
        if (immediateError) {
          throw new Error(immediateError);
        }
      } catch (e) {
        if (BRIDGE_ENABLE_LOGS) {
          console.warn('[Bridge] Port send failed, attempting fallback', e);
        }
        triggerRuntimeFallback('port-postmessage-error');
      }
    });
  };

  const broadcast = (key: string, payload: unknown): void => {
    if (!portRef.current) {
      if (BRIDGE_ENABLE_LOGS) {
        console.warn('[Bridge] Cannot broadcast - disconnected');
      }
      return;
    }

    try {
      portRef.current.postMessage({ type: 'broadcast', key, payload });
    } catch (e) {
      if (BRIDGE_ENABLE_LOGS) {
        console.warn('[Bridge] Broadcast failed:', e);
      }
    }
  };

  const on = (key: string, handler: (payload: unknown) => void): void => {
    if (!eventListenersRef.current.has(key)) {
      eventListenersRef.current.set(key, new Set());
    }
    eventListenersRef.current.get(key)!.add(handler);
  };

  const off = (key: string, handler: (payload: unknown) => void): void => {
    const listeners = eventListenersRef.current.get(key);
    if (listeners) {
      listeners.delete(handler);
      if (listeners.size === 0) {
        eventListenersRef.current.delete(key);
      }
    }
  };

  // Create bridge object with methods bound
  const bridge: Bridge = {
    send,
    broadcast,
    on,
    off,
    get isConnected() {
      return portRef.current !== null && isConnectedRef.current;
    },
    ping: async (): Promise<boolean> => {
      try {
        await send('__ping__', undefined, CONFIG.PING_TIMEOUT);
        return true;
      } catch {
        return false;
      }
    },
    pauseHealthChecks: (durationMs: number): void => {
      const pauseUntil = Date.now() + durationMs;
      healthPausedUntilRef.current = pauseUntil;
      if (BRIDGE_ENABLE_LOGS) {
        console.log(`[Bridge] Health checks paused for ${Math.round(durationMs / 1000)}s`);
      }
    },
    ensureConnected: async (): Promise<boolean> => {
      // First check local state - if we know we're disconnected, don't even try
      if (!isPortValid()) {
        if (BRIDGE_ENABLE_LOGS) {
          console.warn('[Bridge] ensureConnected: Port invalid, triggering reconnect');
        }
        onReconnectNeeded();
        return false;
      }

      // Perform a quick ping with a shorter timeout to verify SW is responsive
      // Use 5s timeout instead of default PING_TIMEOUT for faster failure detection
      const QUICK_PING_TIMEOUT = 5000;
      try {
        await send('__ping__', undefined, QUICK_PING_TIMEOUT);
        return true;
      } catch {
        if (BRIDGE_ENABLE_LOGS) {
          console.warn('[Bridge] ensureConnected: Ping failed, SW may be unresponsive');
        }
        // Don't automatically trigger reconnect here - let the caller decide
        return false;
      }
    },
    sendCritical: async <Req, Res = unknown>(
      key: string,
      payload?: Req,
      options?: CriticalOperationOptions,
      timeoutDuration: number = CONFIG.CRITICAL_OP_TIMEOUT,
    ): Promise<CriticalOperationResult<Res>> => {
      const nonce = options?.nonce || generateNonce();
      const noQueue = options?.noQueue ?? false;

      // If noQueue is true and we're not connected, fail immediately
      if (noQueue && !isPortValid()) {
        throw new Error('Not connected. Please try again.');
      }

      // Wrap payload with nonce and critical flag
      const criticalPayload = {
        __critical__: true,
        __nonce__: nonce,
        __timestamp__: Date.now(),
        data: payload,
      };

      // Set up acknowledgment listener before sending
      let acknowledged = false;
      const ackKey = `__ack__:${nonce}`;
      const ackPromise = new Promise<void>((resolveAck) => {
        const ackHandler = () => {
          acknowledged = true;
          options?.onAcknowledged?.();
          resolveAck();
          off(ackKey, ackHandler);
        };
        on(ackKey, ackHandler);

        // Don't wait forever for ack - but don't reject, just resolve
        setTimeout(() => {
          off(ackKey, ackHandler);
          resolveAck();
        }, 5000);
      });

      if (BRIDGE_ENABLE_LOGS) {
        console.log(`[Bridge] Sending critical operation: ${key} (nonce: ${nonce})`);
      }

      try {
        // Race: wait for acknowledgment while sending the actual request
        // The ack should come quickly if SW receives the message
        const [data] = await Promise.all([
          send<typeof criticalPayload, Res>(key, criticalPayload, timeoutDuration),
          ackPromise,
        ]);

        if (BRIDGE_ENABLE_LOGS) {
          console.log(
            `[Bridge] Critical operation completed: ${key} (nonce: ${nonce}, acked: ${acknowledged})`,
          );
        }

        return {
          data,
          nonce,
          acknowledged,
        };
      } catch (error) {
        if (BRIDGE_ENABLE_LOGS) {
          console.error(
            `[Bridge] Critical operation failed: ${key} (nonce: ${nonce}, acked: ${acknowledged})`,
            error,
          );
        }
        // Re-throw with additional context
        const err = error instanceof Error ? error : new Error(String(error));
        (err as any).nonce = nonce;
        (err as any).acknowledged = acknowledged;
        throw err;
      }
    },
    sendWithNonce: async <Req, Res = unknown>(
      key: string,
      payload?: Req,
      options?: CriticalOperationOptions,
      timeoutDuration?: number,
    ): Promise<CriticalOperationResult<Res>> =>
      bridge.sendCritical(key, payload, options, timeoutDuration),
    sendIdempotent: async <Req, Res = unknown>(
      key: string,
      payload?: Req,
      options?: CriticalOperationOptions,
      timeoutDuration?: number,
    ): Promise<CriticalOperationResult<Res>> =>
      bridge.sendCritical(key, payload, options, timeoutDuration),
  };

  return bridge;
}

// ============================================================================
// Health Monitor
// ============================================================================

interface HealthMonitorDeps {
  bridge: Bridge;
  pingIntervalRef: MutableRefObject<ReturnType<typeof setInterval> | null>;
  consecutivePingFailuresRef: MutableRefObject<number>;
  healthPausedUntilRef: MutableRefObject<number>;
  pingInterval: number;
  setIsServiceWorkerAlive: (alive: boolean) => void;
  onReconnectNeeded: () => void;
  rejectAllPendingRequests: (message: string) => void;
}

function startHealthMonitor(deps: HealthMonitorDeps): void {
  const {
    bridge,
    pingIntervalRef,
    consecutivePingFailuresRef,
    healthPausedUntilRef,
    pingInterval,
    setIsServiceWorkerAlive,
    onReconnectNeeded,
    rejectAllPendingRequests,
  } = deps;

  clearIntervalSafe(pingIntervalRef);
  consecutivePingFailuresRef.current = 0;

  if (BRIDGE_ENABLE_LOGS) {
    console.log(`[Bridge] Starting health monitor (ping every ${pingInterval}ms)`);
  }

  pingIntervalRef.current = setInterval(async () => {
    if (!bridge.isConnected) {
      if (BRIDGE_ENABLE_LOGS) {
        console.log('[Bridge] Health check skipped - not connected');
      }
      return;
    }

    // Check if health checks are paused (set via health:pause broadcast)
    const pausedUntil = healthPausedUntilRef.current;
    if (pausedUntil && Date.now() < pausedUntil) {
      if (BRIDGE_ENABLE_LOGS) {
        const remainingMs = pausedUntil - Date.now();
        console.log(
          `[Bridge] Health check skipped - paused for ${Math.round(remainingMs / 1000)}s more`,
        );
      }
      // Reset failure counter while paused to prevent immediate reconnect when resuming
      consecutivePingFailuresRef.current = 0;
      return;
    }

    const alive = await bridge.ping();

    // Check if interval was cleared during async ping
    if (!pingIntervalRef.current) return;

    // Re-check pause state after async ping (state may have changed via broadcast)
    const pausedUntilAfterPing = healthPausedUntilRef.current;
    if (pausedUntilAfterPing && Date.now() < pausedUntilAfterPing) {
      consecutivePingFailuresRef.current = 0;
      return;
    }

    setIsServiceWorkerAlive(alive);

    if (alive) {
      consecutivePingFailuresRef.current = 0;
      return;
    }

    recordDiagnostics.pingFailure();

    consecutivePingFailuresRef.current++;
    if (BRIDGE_ENABLE_LOGS) {
      console.warn(`[Bridge] Ping failed (${consecutivePingFailuresRef.current}x)`);
    }

    if (consecutivePingFailuresRef.current >= CONFIG.CONSECUTIVE_FAILURE_THRESHOLD) {
      if (BRIDGE_ENABLE_LOGS) {
        console.warn(
          '[Bridge] Service worker unresponsive, rejecting pending requests and reconnecting...',
        );
      }
      consecutivePingFailuresRef.current = 0;
      // Immediately reject all pending requests - don't wait for their individual timeouts
      rejectAllPendingRequests('Service worker unresponsive');
      onReconnectNeeded();
    }
  }, pingInterval);
}

// ============================================================================
// Provider Component
// ============================================================================

export const BridgeProvider: FC<BridgeProviderProps> = ({
  children,
  retryAfter = CONFIG.RETRY_AFTER,
  maxRetries = CONFIG.MAX_RETRIES,
  pingInterval = CONFIG.PING_INTERVAL,
  maxRetryCooldown = CONFIG.MAX_RETRY_COOLDOWN,
  defaultTimeout = CONFIG.DEFAULT_TIMEOUT,
  timeoutFailureThreshold = CONFIG.TIMEOUT_FAILURE_THRESHOLD_MS,
  onConnectionChange,
  onError,
}) => {
  // State
  const [bridge, setBridge] = useState<Bridge | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [error, setError] = useState<Error | null>(null);
  const [isServiceWorkerAlive, setIsServiceWorkerAlive] = useState(false);

  // Connection refs
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const portDisconnectedRef = useRef(false); // Tracks if port received onDisconnect (stale port detection for Windows/Brave)
  const isConnectedRef = useRef(false);
  const isConnectingRef = useRef(false);
  const isReconnectingRef = useRef(false); // Tracks soft reconnection (queue requests instead of failing)

  // Request queue refs - for transparent retry during reconnection
  const requestQueueRef = useRef<QueuedRequest[]>([]);
  const activeIdempotencyKeysRef = useRef<Set<string>>(new Set());
  const queueDrainTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Retry refs
  const retryCountRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxRetryCooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerReconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swRestartRetryCountRef = useRef(0); // Separate counter for SW restart retries (doesn't count against max)

  // Health monitoring refs
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const errorCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const consecutivePingFailuresRef = useRef(0);
  const consecutiveTimeoutsRef = useRef(0);

  // Health pause ref - can be set via broadcast or prop callback
  // This tracks when health checks should be skipped (timestamp until paused)
  const healthPausedUntilRef = useRef<number>(0);

  // Grace period after reconnection - ignore timeouts while SW is starting up
  const reconnectionGracePeriodRef = useRef(false);

  // Message handling refs
  const pendingRequestsRef = useRef(new Map<string, PendingRequest>());
  const eventListenersRef = useRef(new Map<string, Set<(payload: unknown) => void>>());
  const messageIdRef = useRef(0);

  // Refs for visibility handler (avoid stale closures)
  const statusRef = useRef(status);
  const bridgeRef = useRef(bridge);
  const isMountedRef = useRef(true);

  // Reset isMountedRef on every render to handle React Strict Mode double-mounting
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    bridgeRef.current = bridge;
  }, [bridge]);

  // Status management
  const updateStatus = useCallback(
    (newStatus: ConnectionStatus) => {
      setStatus(newStatus);
      onConnectionChange?.(newStatus);
    },
    [onConnectionChange],
  );

  const handleError = useCallback(
    (err: Error) => {
      setError(err);
      onError?.(err);
      updateStatus('error');
    },
    [onError, updateStatus],
  );

  // Cleanup
  const cleanup = useCallback((emitDisconnect = true, preserveQueue = false) => {
    const wasConnected = isConnectedRef.current || portRef.current !== null;

    // Emit disconnected event BEFORE cleanup so listeners can react, but only if we were connected
    if (emitDisconnect && wasConnected) {
      eventListenersRef.current.get('bridge:disconnected')?.forEach((handler) => {
        try {
          handler(undefined);
        } catch (err) {
          if (BRIDGE_ENABLE_LOGS) {
            console.warn('[Bridge] bridge:disconnected handler error:', err);
          }
        }
      });
    }

    clearTimeoutSafe(reconnectTimeoutRef);
    clearTimeoutSafe(triggerReconnectTimeoutRef);
    clearTimeoutSafe(queueDrainTimeoutRef);
    clearIntervalSafe(errorCheckIntervalRef);
    clearIntervalSafe(pingIntervalRef);

    if (portRef.current) {
      try {
        portRef.current.disconnect();
      } catch {
        // Ignore
      }
      portRef.current = null;
    }

    // Reset port disconnected flag for next connection attempt
    portDisconnectedRef.current = false;

    // DON'T reject pending requests if we're preserving queue for soft reconnect
    // Instead, move them to the queue so they can be retried
    if (preserveQueue) {
      const pendingCount = pendingRequestsRef.current.size;
      if (pendingCount > 0 && BRIDGE_ENABLE_LOGS) {
        console.log(
          `[Bridge] Preserving ${pendingCount} pending requests for retry after reconnect`,
        );
      }
      pendingRequestsRef.current.forEach(
        ({ resolve, reject, timeout, timeoutDuration, key, payload }, id) => {
          clearTimeout(timeout);
          // Queue for retry (will be sent when reconnected)
          requestQueueRef.current.push({
            id,
            key,
            payload, // Preserve the original payload for retry
            timeoutDuration,
            resolve,
            reject,
            retryCount: 0,
            maxRetries: CONFIG.REQUEST_MAX_RETRIES,
            queuedAt: Date.now(),
          });
          if (BRIDGE_ENABLE_LOGS) {
            console.log(`[Bridge] Queued pending request for retry: ${key}`);
          }
        },
      );
      pendingRequestsRef.current.clear();
    } else {
      // Hard cleanup - reject all pending
      pendingRequestsRef.current.forEach(({ reject, timeout }) => {
        clearTimeout(timeout);
        reject(new Error('Bridge disconnected'));
      });
      pendingRequestsRef.current.clear();

      // Also reject queued requests on hard cleanup
      requestQueueRef.current.forEach(({ reject, idempotencyKey }) => {
        if (idempotencyKey) {
          activeIdempotencyKeysRef.current.delete(idempotencyKey);
        }
        reject(new Error('Bridge disconnected'));
      });
      requestQueueRef.current = [];
      activeIdempotencyKeysRef.current.clear();
    }

    // NOTE: We do NOT clear eventListenersRef during reconnection - listeners should persist
    // However, if emitDisconnect is false (unmount), we should clear listeners to prevent memory leaks
    if (!emitDisconnect) {
      eventListenersRef.current.clear();
    }

    // Reset state
    setIsServiceWorkerAlive(false);
    setBridge(null);
    isConnectingRef.current = false;
    isConnectedRef.current = false;
  }, []);

  // Message handler
  const handleMessage = useCallback((message: BridgeMessage) => {
    // Handle request/response
    if (message.id && pendingRequestsRef.current.has(message.id)) {
      const pending = pendingRequestsRef.current.get(message.id)!;
      clearTimeout(pending.timeout);
      consecutiveTimeoutsRef.current = 0;

      if (message.error) {
        pending.reject(new Error(message.error));
      } else {
        pending.resolve(message.data);
      }

      pendingRequestsRef.current.delete(message.id);
      return;
    }

    // Handle broadcasts
    if (message.type === 'broadcast' && message.key) {
      const listeners = eventListenersRef.current.get(message.key);
      const listenerCount = listeners?.size ?? 0;

      if (BRIDGE_ENABLE_LOGS) {
        console.log(
          `[Bridge] 📡 Received broadcast: ${message.key}, dispatching to ${listenerCount} listeners`,
        );
      }

      listeners?.forEach((handler) => {
        try {
          handler(message.payload);
        } catch (err) {
          if (BRIDGE_ENABLE_LOGS) {
            console.warn('[Bridge] Event handler error:', err);
          }
        }
      });
      return;
    }

    // Log unhandled messages (response for already-timed-out request, or malformed message)
    if (message.id && BRIDGE_ENABLE_LOGS) {
      console.warn('[Bridge] Received response for unknown/expired request:', message.id);
    }
  }, []);

  // Drain request queue - called after successful reconnection
  // This processes queued requests one by one with small delays to avoid overwhelming the SW
  const drainRequestQueue = useCallback(() => {
    if (requestQueueRef.current.length === 0) {
      if (BRIDGE_ENABLE_LOGS) {
        console.log('[Bridge] Request queue empty, nothing to drain');
      }
      return;
    }

    if (!bridgeRef.current || !isConnectedRef.current) {
      if (BRIDGE_ENABLE_LOGS) {
        console.log('[Bridge] Cannot drain queue - not connected');
      }
      return;
    }

    if (BRIDGE_ENABLE_LOGS) {
      console.log(`[Bridge] Draining request queue (${requestQueueRef.current.length} requests)`);
    }

    const processNextRequest = () => {
      if (!isMountedRef.current || !isConnectedRef.current) return;

      const request = requestQueueRef.current.shift();
      if (!request) {
        // Queue exhausted
        if (BRIDGE_ENABLE_LOGS) {
          console.log('[Bridge] Request queue drained successfully');
        }
        return;
      }

      // Check if request has expired (been in queue too long)
      const queuedDuration = Date.now() - request.queuedAt;
      if (queuedDuration > request.timeoutDuration) {
        if (BRIDGE_ENABLE_LOGS) {
          console.warn(`[Bridge] Queued request expired: ${request.key}`);
        }
        if (request.idempotencyKey) {
          activeIdempotencyKeysRef.current.delete(request.idempotencyKey);
        }
        request.reject(new Error(`Request expired while queued: ${request.key}`));
        // Process next request
        queueDrainTimeoutRef.current = setTimeout(processNextRequest, CONFIG.QUEUE_DRAIN_DELAY);
        return;
      }

      if (BRIDGE_ENABLE_LOGS) {
        console.log(
          `[Bridge] Re-sending queued request: ${request.key} (retry ${request.retryCount + 1}/${request.maxRetries})`,
        );
      }

      // Re-send the request using the bridge
      bridgeRef
        .current!.send(request.key, request.payload, request.timeoutDuration - queuedDuration)
        .then((data) => {
          if (BRIDGE_ENABLE_LOGS) {
            console.log(`[Bridge] ✅ Queued request succeeded: ${request.key}`);
          }
          if (request.idempotencyKey) {
            activeIdempotencyKeysRef.current.delete(request.idempotencyKey);
          }
          request.resolve(data);
        })
        .catch((error) => {
          request.retryCount++;

          if (request.retryCount < request.maxRetries && isConnectedRef.current) {
            // Re-queue for retry with exponential backoff
            const retryDelay = calculateBackoffDelay(
              request.retryCount,
              CONFIG.REQUEST_RETRY_BASE_DELAY,
              CONFIG.REQUEST_RETRY_MAX_DELAY,
            );

            if (BRIDGE_ENABLE_LOGS) {
              console.log(
                `[Bridge] Request failed, re-queuing: ${request.key} (retry in ${retryDelay}ms)`,
              );
            }

            setTimeout(() => {
              if (isMountedRef.current) {
                requestQueueRef.current.unshift(request); // Add to front for immediate retry
                processNextRequest();
              }
            }, retryDelay);
            return;
          }

          // Max retries exceeded - give up
          if (BRIDGE_ENABLE_LOGS) {
            console.error(
              `[Bridge] ❌ Queued request failed after ${request.maxRetries} retries: ${request.key}`,
              error,
            );
          }
          if (request.idempotencyKey) {
            activeIdempotencyKeysRef.current.delete(request.idempotencyKey);
          }
          request.reject(error);
        })
        .finally(() => {
          // Process next request after a small delay
          if (isMountedRef.current) {
            queueDrainTimeoutRef.current = setTimeout(processNextRequest, CONFIG.QUEUE_DRAIN_DELAY);
          }
        });
    };

    // Start processing
    processNextRequest();
  }, []);

  // Schedule reconnect with backoff
  const scheduleReconnect = useCallback(
    (connectFn: () => void) => {
      if (!isMountedRef.current) return;

      if (retryCountRef.current < maxRetries) {
        retryCountRef.current++;
        const delay = calculateBackoffDelay(
          retryCountRef.current,
          retryAfter,
          CONFIG.MAX_RETRY_DELAY,
        );
        if (BRIDGE_ENABLE_LOGS) {
          console.log(
            `[Bridge] Reconnecting in ${delay}ms (${retryCountRef.current}/${maxRetries})`,
          );
        }
        updateStatus('reconnecting');
        reconnectTimeoutRef.current = setTimeout(() => {
          if (isMountedRef.current) connectFn();
        }, delay);
      } else {
        if (BRIDGE_ENABLE_LOGS) {
          console.warn(`[Bridge] Max retries reached. Cooldown: ${maxRetryCooldown}ms`);
        }
        clearTimeoutSafe(maxRetryCooldownRef);
        maxRetryCooldownRef.current = setTimeout(() => {
          if (!isMountedRef.current) return;
          if (BRIDGE_ENABLE_LOGS) {
            console.log('[Bridge] Cooldown complete, reconnecting...');
          }
          retryCountRef.current = 0;
          connectFn();
        }, maxRetryCooldown);
      }
    },
    [maxRetries, retryAfter, maxRetryCooldown, updateStatus],
  );

  // Schedule reconnect specifically for SW restart - doesn't count against max retries
  // This handles the case when the service worker is restarting and not yet available
  const scheduleSwRestartReconnect = useCallback(
    (connectFn: () => void) => {
      if (BRIDGE_ENABLE_LOGS) {
        console.log('[Bridge] scheduleSwRestartReconnect called, isMounted:', isMountedRef.current);
      }

      if (!isMountedRef.current) {
        if (BRIDGE_ENABLE_LOGS) {
          console.log('[Bridge] Not mounted, skipping SW restart reconnect');
        }
        return;
      }

      // Enable soft reconnection mode - queue requests instead of failing
      isReconnectingRef.current = true;

      swRestartRetryCountRef.current++;
      const delay = calculateBackoffDelay(
        swRestartRetryCountRef.current,
        CONFIG.SW_RESTART_RETRY_DELAY,
        CONFIG.SW_RESTART_MAX_DELAY,
      );

      if (BRIDGE_ENABLE_LOGS) {
        console.log(
          `[Bridge] Service worker not ready, retrying in ${delay}ms (attempt ${swRestartRetryCountRef.current})`,
        );
      }
      updateStatus('reconnecting');

      reconnectTimeoutRef.current = setTimeout(() => {
        if (BRIDGE_ENABLE_LOGS) {
          console.log('[Bridge] SW restart timeout fired, isMounted:', isMountedRef.current);
        }
        if (isMountedRef.current) connectFn();
      }, delay);
    },
    [updateStatus],
  );

  // Main connection logic
  const connect = useCallback(() => {
    if (BRIDGE_ENABLE_LOGS) {
      console.log('[Bridge] connect() called, isConnecting:', isConnectingRef.current);
    }

    if (isConnectingRef.current) {
      if (BRIDGE_ENABLE_LOGS) {
        console.log('[Bridge] Already connecting, skipping...');
      }
      return;
    }

    // Reset retry count if we've been waiting - don't block reconnection attempts
    // The SW restart retry path handles its own backoff

    isConnectingRef.current = true;
    // Use soft cleanup - preserve request queue for retry
    cleanup(false, true); // Internal reset before attempting new connection, but preserve queue

    if (!chrome?.runtime?.connect) {
      handleError(new Error('Chrome runtime not available'));
      isConnectingRef.current = false;
      return;
    }

    try {
      if (BRIDGE_ENABLE_LOGS) {
        console.log('[Bridge] Attempting chrome.runtime.connect...');
      }
      const port = chrome.runtime.connect({ name: CONFIG.PORT_NAME });
      const immediateError = consumeRuntimeError();
      if (immediateError) throw new Error(immediateError);

      if (BRIDGE_ENABLE_LOGS) {
        console.log('[Bridge] Port created successfully:', port.name);
      }
      portRef.current = port;

      // Monitor for early connection errors
      let errorChecks = 0;
      errorCheckIntervalRef.current = setInterval(() => {
        errorChecks++;
        const err = consumeRuntimeError();

        if (err) {
          clearIntervalSafe(errorCheckIntervalRef);
          if (err.includes('Receiving end does not exist')) {
            if (BRIDGE_ENABLE_LOGS) {
              console.warn('[Bridge] Service worker not ready (may be restarting)...');
            }
            cleanup(false); // No active port yet, just reset before retrying
            isConnectingRef.current = false;
            // Use SW restart retry - doesn't count against max retries
            scheduleSwRestartReconnect(connect);
          }
          return;
        }

        if (errorChecks >= CONFIG.MAX_ERROR_CHECKS) {
          clearIntervalSafe(errorCheckIntervalRef);
        }
      }, CONFIG.ERROR_CHECK_INTERVAL);

      // Set up listeners
      port.onMessage.addListener(handleMessage);

      port.onDisconnect.addListener(() => {
        if (BRIDGE_ENABLE_LOGS) {
          console.warn('[Bridge] *** onDisconnect FIRED ***');
        }

        // Mark port as disconnected IMMEDIATELY to prevent stale port usage
        // This is critical on Windows/Brave where the port object may still exist
        // but can't send messages after onDisconnect fires
        portDisconnectedRef.current = true;
        isConnectingRef.current = false;

        const disconnectError = consumeRuntimeError();

        recordDiagnostics.portDisconnect(disconnectError);

        if (BRIDGE_ENABLE_LOGS) {
          console.warn('[Bridge] Disconnect error:', disconnectError || '(none)');
          console.warn('[Bridge] isMounted:', isMountedRef.current);
        }

        updateStatus('disconnected');
        // Use soft cleanup - preserve queue for transparent retry
        cleanup(true, true);

        // Only schedule reconnect if still mounted
        // Always use SW restart retry (infinite) since any disconnect could be SW stopping
        if (isMountedRef.current) {
          if (BRIDGE_ENABLE_LOGS) {
            console.log('[Bridge] Scheduling SW restart reconnect...');
          }
          scheduleSwRestartReconnect(connect);
        } else {
          if (BRIDGE_ENABLE_LOGS) {
            console.log('[Bridge] Not mounted, NOT scheduling reconnect');
          }
        }
      });

      // Helper for triggering reconnection
      const triggerReconnect = () => {
        if (!isMountedRef.current) return;
        setIsServiceWorkerAlive(false);
        updateStatus('reconnecting');
        isReconnectingRef.current = true; // Enable request queueing
        retryCountRef.current = 0;
        isConnectingRef.current = false;
        clearTimeoutSafe(triggerReconnectTimeoutRef);
        triggerReconnectTimeoutRef.current = setTimeout(() => {
          if (!isMountedRef.current) return;
          cleanup(false, true); // Soft cleanup - preserve queue
          connect();
        }, CONFIG.RECONNECT_DELAY);
      };

      // Create bridge instance
      const bridgeInstance = createBridgeInstance({
        portRef,
        portDisconnectedRef,
        pendingRequestsRef,
        requestQueueRef,
        activeIdempotencyKeysRef,
        eventListenersRef,
        messageIdRef,
        isConnectedRef,
        isReconnectingRef,
        consecutiveTimeoutsRef,
        reconnectionGracePeriodRef,
        healthPausedUntilRef,
        defaultTimeout,
        timeoutFailureThreshold,
        onReconnectNeeded: triggerReconnect,
        drainRequestQueue,
      });

      // Mark connected - reset disconnected flag since we have a fresh port
      portDisconnectedRef.current = false;
      isReconnectingRef.current = false; // Disable request queueing - we're connected now
      setBridge(bridgeInstance);
      isConnectedRef.current = true;
      updateStatus('connected');
      setIsServiceWorkerAlive(true);
      setError(null);
      retryCountRef.current = 0;
      swRestartRetryCountRef.current = 0; // Reset SW restart counter on success
      consecutiveTimeoutsRef.current = 0;
      isConnectingRef.current = false;

      if (BRIDGE_ENABLE_LOGS) {
        const queueSize = requestQueueRef.current.length;
        const pendingSize = pendingRequestsRef.current.size;
        console.log(`[Bridge] ✅ PORT CONNECTED | Queued: ${queueSize} | Pending: ${pendingSize}`);
      }

      // Verify the connection actually works with a ping before proceeding
      // This catches the case where the port appears connected but the SW isn't responding
      // We capture the port reference to detect if it changed (e.g., React Strict Mode remount)
      const verifyConnection = (targetPort: chrome.runtime.Port): Promise<boolean> => {
        const VERIFY_PING_TIMEOUT = 8000; // 8s per attempt (SW can be slow during bootstrap)
        const MAX_VERIFY_RETRIES = 3; // Fewer retries to reduce total time
        const VERIFY_RETRY_DELAY = 2000; // Longer delay between retries to give SW more time

        const attemptVerify = (attempt: number): Promise<boolean> => {
          // Abort if this port is no longer the current port (e.g., component remounted)
          if (portRef.current !== targetPort) {
            if (BRIDGE_ENABLE_LOGS) {
              console.log(`[Bridge] Verification aborted - port changed (attempt ${attempt})`);
            }
            return Promise.resolve(false);
          }

          if (attempt > MAX_VERIFY_RETRIES) {
            return Promise.resolve(false);
          }

          if (BRIDGE_ENABLE_LOGS) {
            console.log(
              `[Bridge] Verifying connection (attempt ${attempt}/${MAX_VERIFY_RETRIES})...`,
            );
          }

          // Use direct port message instead of bridgeInstance.ping() to avoid queue issues
          const pingId = `verify_${Date.now()}_${attempt}`;
          return new Promise<boolean>((resolve) => {
            // Abort check before setting up timeout
            if (portRef.current !== targetPort) {
              resolve(false);
              return;
            }

            const timeout = setTimeout(() => {
              pendingRequestsRef.current.delete(pingId);
              // Abort if port changed during timeout
              if (portRef.current !== targetPort) {
                resolve(false);
                return;
              }
              // Retry on timeout
              if (BRIDGE_ENABLE_LOGS) {
                console.warn(`[Bridge] Verification ping timeout (attempt ${attempt})`);
              }
              setTimeout(() => {
                attemptVerify(attempt + 1).then(resolve);
              }, VERIFY_RETRY_DELAY);
            }, VERIFY_PING_TIMEOUT);

            pendingRequestsRef.current.set(pingId, {
              resolve: () => {
                clearTimeout(timeout);
                // Only report success if this is still the current port
                if (portRef.current !== targetPort) {
                  resolve(false);
                  return;
                }
                if (BRIDGE_ENABLE_LOGS) {
                  console.log('[Bridge] ✅ VERIFIED - SW is responding');
                }
                resolve(true);
              },
              reject: () => {
                clearTimeout(timeout);
                // Abort if port changed
                if (portRef.current !== targetPort) {
                  resolve(false);
                  return;
                }
                // Retry on error
                if (BRIDGE_ENABLE_LOGS) {
                  console.warn(`[Bridge] Verification ping error (attempt ${attempt})`);
                }
                setTimeout(() => {
                  attemptVerify(attempt + 1).then(resolve);
                }, VERIFY_RETRY_DELAY);
              },
              timeout,
              timeoutDuration: VERIFY_PING_TIMEOUT,
              key: '__ping__',
              payload: undefined,
            });

            try {
              targetPort.postMessage({ id: pingId, key: '__ping__', payload: undefined });
            } catch (e) {
              clearTimeout(timeout);
              pendingRequestsRef.current.delete(pingId);
              // Abort if port changed
              if (portRef.current !== targetPort) {
                resolve(false);
                return;
              }
              if (BRIDGE_ENABLE_LOGS) {
                console.warn(`[Bridge] Verification postMessage error (attempt ${attempt}):`, e);
              }
              // Retry on postMessage error
              setTimeout(() => {
                attemptVerify(attempt + 1).then(resolve);
              }, VERIFY_RETRY_DELAY);
            }
          });
        };

        return attemptVerify(1);
      };

      // Verify connection before draining queue (using .then() to keep connect() synchronous)
      // Add initial delay to give SW time to bootstrap its message handlers after port connects
      const startVerification = () => {
        if (BRIDGE_ENABLE_LOGS) {
          console.log('[Bridge] Starting verification after initial delay...');
        }
        verifyConnection(port).then((verified) => {
          // Abort if port changed or component unmounted
          if (!isMountedRef.current || portRef.current !== port) {
            if (BRIDGE_ENABLE_LOGS) {
              console.log('[Bridge] Verification callback aborted - context changed');
            }
            return;
          }

          if (!verified) {
            if (BRIDGE_ENABLE_LOGS) {
              console.error('[Bridge] ❌ Connection verification failed - SW not responding');
            }
            // Connection appears broken - trigger reconnection
            isConnectingRef.current = false;
            isReconnectingRef.current = true;
            scheduleSwRestartReconnect(connect);
            return;
          }

          if (BRIDGE_ENABLE_LOGS) {
            const queueSize = requestQueueRef.current.length;
            console.log(
              `[Bridge] ✅ RECONNECTED SUCCESSFULLY | Queue: ${queueSize} requests to drain`,
            );
          }

          // Drain queued requests after verified connection
          // Small delay to let the SW fully initialize handlers
          setTimeout(() => {
            if (isMountedRef.current && isConnectedRef.current) {
              drainRequestQueue();
            }
          }, 200);

          // Emit bridge:connected event for stores to re-initialize
          // Only emit AFTER verification succeeds (moved from outside .then())
          if (BRIDGE_ENABLE_LOGS) {
            console.log('[Bridge] Emitting bridge:connected event to stores');
          }
          eventListenersRef.current.get('bridge:connected')?.forEach((handler) => {
            try {
              handler({ timestamp: Date.now() });
            } catch (err) {
              if (BRIDGE_ENABLE_LOGS) {
                console.warn('[Bridge] bridge:connected handler error:', err);
              }
            }
          });
        });
      };

      // Start verification after a short delay to give SW time to register handlers
      // This is especially important after SW restart where bootstrap is still in progress
      // Increased to 2s to allow SW to fully initialize before we start pinging
      setTimeout(startVerification, 2000);

      // Start grace period - give SW time to fully initialize handlers
      // This prevents "Bridge reconnecting due to timeouts" right after connection
      // Increased to 10s for Windows where SW startup and handler registration is slower
      reconnectionGracePeriodRef.current = true;
      setTimeout(() => {
        reconnectionGracePeriodRef.current = false;
        if (BRIDGE_ENABLE_LOGS) {
          console.log('[Bridge] Grace period ended, timeout monitoring active');
        }
      }, 10000); // 10 second grace period (increased for slow environments)

      // Helper to reject pending requests with short timeouts (used by health monitor)
      // Only rejects short-timeout requests - long-timeout requests are intentional slow operations
      const rejectAllPendingRequests = (message: string) => {
        pendingRequestsRef.current.forEach(({ reject, timeout, timeoutDuration }, id) => {
          if (timeoutDuration <= timeoutFailureThreshold) {
            clearTimeout(timeout);
            reject(new Error(message));
            pendingRequestsRef.current.delete(id);
          }
        });
        consecutiveTimeoutsRef.current = 0; // Reset so we don't double-trigger reconnection
      };

      // Start health monitoring
      startHealthMonitor({
        bridge: bridgeInstance,
        pingIntervalRef,
        consecutivePingFailuresRef,
        healthPausedUntilRef,
        pingInterval,
        setIsServiceWorkerAlive,
        onReconnectNeeded: triggerReconnect,
        rejectAllPendingRequests,
      });
    } catch (e) {
      isConnectingRef.current = false;
      handleError(e instanceof Error ? e : new Error('Connection failed'));
      scheduleReconnect(connect);
    }
  }, [
    maxRetries,
    cleanup,
    handleError,
    handleMessage,
    scheduleReconnect,
    scheduleSwRestartReconnect,
    drainRequestQueue,
    defaultTimeout,
    updateStatus,
    pingInterval,
  ]);

  // Manual reconnect
  const reconnect = useCallback(() => {
    retryCountRef.current = 0;
    consecutiveTimeoutsRef.current = 0;
    updateStatus('connecting');
    connect();
  }, [connect, updateStatus]);

  // Lifecycle
  useEffect(() => {
    // Guard against duplicate connections in React Strict Mode or hot reload
    if (portRef.current || isConnectingRef.current) {
      if (BRIDGE_ENABLE_LOGS) {
        console.log('[Bridge] Lifecycle: Connection already exists, skipping connect()');
      }
      return;
    }

    connect();

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (!isMountedRef.current) return;
      if (isConnectingRef.current) return; // Prevent race condition

      const currentStatus = statusRef.current;
      const currentBridge = bridgeRef.current;

      if (
        currentStatus === 'disconnected' ||
        currentStatus === 'error' ||
        currentStatus === 'reconnecting'
      ) {
        if (BRIDGE_ENABLE_LOGS) {
          console.log('[Bridge] Tab visible, reconnecting...');
        }
        retryCountRef.current = 0;
        swRestartRetryCountRef.current = 0;
        isConnectingRef.current = false; // Reset so connect() doesn't early-exit
        connect();
      } else if (currentStatus === 'connected' && currentBridge) {
        // Double-check we're not already reconnecting before pinging
        if (isConnectingRef.current) return;

        currentBridge
          .ping()
          .then((alive) => {
            // Check mounted AND not already connecting before acting on async result
            if (!isMountedRef.current) return;
            if (isConnectingRef.current) return; // Another reconnect started while we were pinging

            if (!alive) {
              if (BRIDGE_ENABLE_LOGS) {
                console.warn('[Bridge] Tab visible but unresponsive, reconnecting...');
              }
              retryCountRef.current = 0;
              swRestartRetryCountRef.current = 0;
              isConnectingRef.current = false;
              cleanup();
              connect();
            }
          })
          .catch(() => {
            // Ping failed (port disconnected, etc.) - ignore, onDisconnect will handle it
          });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearTimeoutSafe(maxRetryCooldownRef);
      cleanup(false); // Don't emit disconnect on unmount - component is being destroyed
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount, ignore callback changes

  // Context value
  const contextValue = useMemo<BridgeContextValue>(
    () => ({ bridge, status, error, reconnect, isServiceWorkerAlive }),
    [bridge, status, error, reconnect, isServiceWorkerAlive],
  );

  return <BridgeContext.Provider value={contextValue}>{children}</BridgeContext.Provider>;
};
