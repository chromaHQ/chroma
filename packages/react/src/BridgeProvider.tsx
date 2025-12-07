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

// ============================================================================
// Types
// ============================================================================

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error' | 'reconnecting';

interface Bridge {
  send: <Req = unknown, Res = unknown>(
    key: string,
    payload?: Req,
    timeoutDuration?: number,
  ) => Promise<Res>;
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
  /** Default timeout for messages in ms. Default: 10000 */
  defaultTimeout?: number;
  /** Callback when connection status changes */
  onConnectionChange?: (status: ConnectionStatus) => void;
  /** Callback when an error occurs */
  onError?: (error: Error) => void;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
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
  PING_INTERVAL: 3000, // Check every 3s (balance between responsiveness and false positives)
  MAX_RETRY_COOLDOWN: 30000,
  DEFAULT_TIMEOUT: 10000,
  MAX_RETRY_DELAY: 30000,
  PING_TIMEOUT: 5000, // Give SW 5s to respond (handles busy periods)
  ERROR_CHECK_INTERVAL: 100,
  MAX_ERROR_CHECKS: 10,
  CONSECUTIVE_FAILURE_THRESHOLD: 3, // Require 3 consecutive failures (9s total) before reconnecting
  RECONNECT_DELAY: 100,
  PORT_NAME: 'chroma-bridge',
  // Service worker restart retry settings (indefinite retries)
  SW_RESTART_RETRY_DELAY: 500,
  SW_RESTART_MAX_DELAY: 5000,
} as const;

// ============================================================================
// Utilities
// ============================================================================

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
  pendingRequestsRef: MutableRefObject<Map<string, PendingRequest>>;
  eventListenersRef: MutableRefObject<Map<string, Set<(payload: unknown) => void>>>;
  messageIdRef: MutableRefObject<number>;
  isConnectedRef: MutableRefObject<boolean>;
  consecutiveTimeoutsRef: MutableRefObject<number>;
  reconnectionGracePeriodRef: MutableRefObject<boolean>;
  healthPausedUntilRef: MutableRefObject<number>;
  defaultTimeout: number;
  onReconnectNeeded: () => void;
}

function createBridgeInstance(deps: BridgeFactoryDeps): Bridge {
  const {
    portRef,
    pendingRequestsRef,
    eventListenersRef,
    messageIdRef,
    isConnectedRef,
    consecutiveTimeoutsRef,
    reconnectionGracePeriodRef,
    healthPausedUntilRef,
    defaultTimeout,
    onReconnectNeeded,
  } = deps;

  const rejectAllPending = (message: string) => {
    pendingRequestsRef.current.forEach(({ reject, timeout }) => {
      clearTimeout(timeout);
      reject(new Error(message));
    });
    pendingRequestsRef.current.clear();
  };

  const send = <Req, Res = unknown>(
    key: string,
    payload?: Req,
    timeoutDuration: number = defaultTimeout,
  ): Promise<Res> => {
    return new Promise((resolve, reject) => {
      if (!portRef.current) {
        reject(new Error('Bridge disconnected'));
        return;
      }

      const id = `msg_${++messageIdRef.current}`;

      const timeout = setTimeout(() => {
        if (!pendingRequestsRef.current.has(id)) return;

        pendingRequestsRef.current.delete(id);

        // Don't count timeouts during grace period (SW still starting up)
        if (!reconnectionGracePeriodRef.current) {
          consecutiveTimeoutsRef.current++;
        }

        if (BRIDGE_ENABLE_LOGS) {
          console.warn(
            `[Bridge] Request timed out: ${key} (${timeoutDuration}ms)${reconnectionGracePeriodRef.current ? ' [grace period]' : ''}`,
          );
        }

        // Trigger reconnect on consecutive timeouts (but not during grace period)
        if (
          !reconnectionGracePeriodRef.current &&
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
      });

      try {
        portRef.current.postMessage({ id, key, payload });

        // Check for async runtime errors
        setTimeout(() => {
          const errorMessage = consumeRuntimeError();
          if (errorMessage && pendingRequestsRef.current.has(id)) {
            const pending = pendingRequestsRef.current.get(id);
            if (pending) {
              clearTimeout(pending.timeout);
              pendingRequestsRef.current.delete(id);
              reject(new Error(errorMessage));
            }
          }
        }, 0);

        // Check for immediate errors
        const immediateError = consumeRuntimeError();
        if (immediateError) {
          throw new Error(immediateError);
        }
      } catch (e) {
        const pending = pendingRequestsRef.current.get(id);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingRequestsRef.current.delete(id);
        }
        reject(e instanceof Error ? e : new Error('Send failed'));
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
  const isConnectedRef = useRef(false);
  const isConnectingRef = useRef(false);

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
  const cleanup = useCallback((emitDisconnect = true) => {
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

    // Reject pending requests
    pendingRequestsRef.current.forEach(({ reject, timeout }) => {
      clearTimeout(timeout);
      reject(new Error('Bridge disconnected'));
    });
    pendingRequestsRef.current.clear();
    // NOTE: We do NOT clear eventListenersRef here - listeners should persist across reconnections

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
      eventListenersRef.current.get(message.key)?.forEach((handler) => {
        try {
          handler(message.payload);
        } catch (err) {
          if (BRIDGE_ENABLE_LOGS) {
            console.warn('[Bridge] Event handler error:', err);
          }
        }
      });
    }
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
    cleanup(false); // Internal reset before attempting new connection

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
        isConnectingRef.current = false;

        const disconnectError = consumeRuntimeError();

        if (BRIDGE_ENABLE_LOGS) {
          console.warn('[Bridge] Disconnect error:', disconnectError || '(none)');
          console.warn('[Bridge] isMounted:', isMountedRef.current);
        }

        updateStatus('disconnected');
        cleanup();

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
        retryCountRef.current = 0;
        isConnectingRef.current = false;
        clearTimeoutSafe(triggerReconnectTimeoutRef);
        triggerReconnectTimeoutRef.current = setTimeout(() => {
          if (!isMountedRef.current) return;
          cleanup(false); // Already notified when entering reconnecting state
          connect();
        }, CONFIG.RECONNECT_DELAY);
      };

      // Create bridge instance
      const bridgeInstance = createBridgeInstance({
        portRef,
        pendingRequestsRef,
        eventListenersRef,
        messageIdRef,
        isConnectedRef,
        consecutiveTimeoutsRef,
        reconnectionGracePeriodRef,
        healthPausedUntilRef,
        defaultTimeout,
        onReconnectNeeded: triggerReconnect,
      });

      // Mark connected
      setBridge(bridgeInstance);
      isConnectedRef.current = true;
      updateStatus('connected');
      setIsServiceWorkerAlive(true);
      setError(null);
      retryCountRef.current = 0;
      swRestartRetryCountRef.current = 0; // Reset SW restart counter on success
      consecutiveTimeoutsRef.current = 0;
      isConnectingRef.current = false;

      // Start grace period - give SW time to fully initialize handlers
      // This prevents "Bridge reconnecting due to timeouts" right after connection
      reconnectionGracePeriodRef.current = true;
      setTimeout(() => {
        reconnectionGracePeriodRef.current = false;
        if (BRIDGE_ENABLE_LOGS) {
          console.log('[Bridge] Grace period ended, timeout monitoring active');
        }
      }, 3000); // 3 second grace period

      // Emit bridge:connected event for stores to re-initialize
      // This is dispatched directly to local listeners (not over the port)
      eventListenersRef.current.get('bridge:connected')?.forEach((handler) => {
        try {
          handler({ timestamp: Date.now() });
        } catch (err) {
          if (BRIDGE_ENABLE_LOGS) {
            console.warn('[Bridge] bridge:connected handler error:', err);
          }
        }
      });

      // Helper to reject all pending requests (used by health monitor)
      const rejectAllPendingRequests = (message: string) => {
        pendingRequestsRef.current.forEach(({ reject, timeout }) => {
          clearTimeout(timeout);
          reject(new Error(message));
        });
        pendingRequestsRef.current.clear();
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
        currentBridge.ping().then((alive) => {
          // Check mounted before acting on async result
          if (!isMountedRef.current) return;
          if (!alive) {
            if (BRIDGE_ENABLE_LOGS) {
              console.warn('[Bridge] Tab visible but unresponsive, reconnecting...');
            }
            retryCountRef.current = 0;
            isConnectingRef.current = false;
            cleanup();
            connect();
          }
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
