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
  PING_INTERVAL: 5000,
  MAX_RETRY_COOLDOWN: 30000,
  DEFAULT_TIMEOUT: 10000,
  MAX_RETRY_DELAY: 30000,
  PING_TIMEOUT: 2000,
  ERROR_CHECK_INTERVAL: 100,
  MAX_ERROR_CHECKS: 10,
  CONSECUTIVE_FAILURE_THRESHOLD: 2,
  RECONNECT_DELAY: 100,
  PORT_NAME: 'chroma-bridge',
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
        consecutiveTimeoutsRef.current++;

        console.warn(`[Bridge] Request timed out: ${key} (${timeoutDuration}ms)`);

        // Trigger reconnect on consecutive timeouts
        if (consecutiveTimeoutsRef.current >= CONFIG.CONSECUTIVE_FAILURE_THRESHOLD) {
          console.warn(
            `[Bridge] ${consecutiveTimeoutsRef.current} consecutive timeouts, reconnecting...`,
          );
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
      console.warn('[Bridge] Cannot broadcast - disconnected');
      return;
    }

    try {
      portRef.current.postMessage({ type: 'broadcast', key, payload });
    } catch (e) {
      console.warn('[Bridge] Broadcast failed:', e);
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
  pingInterval: number;
  setIsServiceWorkerAlive: (alive: boolean) => void;
  onReconnectNeeded: () => void;
}

function startHealthMonitor(deps: HealthMonitorDeps): void {
  const {
    bridge,
    pingIntervalRef,
    consecutivePingFailuresRef,
    pingInterval,
    setIsServiceWorkerAlive,
    onReconnectNeeded,
  } = deps;

  clearIntervalSafe(pingIntervalRef);
  consecutivePingFailuresRef.current = 0;

  pingIntervalRef.current = setInterval(async () => {
    if (!bridge.isConnected) return;

    const alive = await bridge.ping();

    // Check if interval was cleared during async ping
    if (!pingIntervalRef.current) return;

    setIsServiceWorkerAlive(alive);

    if (alive) {
      consecutivePingFailuresRef.current = 0;
      return;
    }

    consecutivePingFailuresRef.current++;
    console.warn(`[Bridge] Ping failed (${consecutivePingFailuresRef.current}x)`);

    if (consecutivePingFailuresRef.current >= CONFIG.CONSECUTIVE_FAILURE_THRESHOLD) {
      console.warn('[Bridge] Service worker unresponsive, reconnecting...');
      consecutivePingFailuresRef.current = 0;
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

  // Health monitoring refs
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const errorCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const consecutivePingFailuresRef = useRef(0);
  const consecutiveTimeoutsRef = useRef(0);

  // Message handling refs
  const pendingRequestsRef = useRef(new Map<string, PendingRequest>());
  const eventListenersRef = useRef(new Map<string, Set<(payload: unknown) => void>>());
  const messageIdRef = useRef(0);

  // Refs for visibility handler (avoid stale closures)
  const statusRef = useRef(status);
  const bridgeRef = useRef(bridge);
  const isMountedRef = useRef(true);

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
  const cleanup = useCallback(() => {
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
    eventListenersRef.current.clear();

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
          console.warn('[Bridge] Event handler error:', err);
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
        console.log(`[Bridge] Reconnecting in ${delay}ms (${retryCountRef.current}/${maxRetries})`);
        updateStatus('reconnecting');
        reconnectTimeoutRef.current = setTimeout(() => {
          if (isMountedRef.current) connectFn();
        }, delay);
      } else {
        console.warn(`[Bridge] Max retries reached. Cooldown: ${maxRetryCooldown}ms`);
        clearTimeoutSafe(maxRetryCooldownRef);
        maxRetryCooldownRef.current = setTimeout(() => {
          if (!isMountedRef.current) return;
          console.log('[Bridge] Cooldown complete, reconnecting...');
          retryCountRef.current = 0;
          connectFn();
        }, maxRetryCooldown);
      }
    },
    [maxRetries, retryAfter, maxRetryCooldown, updateStatus],
  );

  // Main connection logic
  const connect = useCallback(() => {
    if (isConnectingRef.current) return;
    if (retryCountRef.current >= maxRetries) {
      console.warn('[Bridge] Waiting for cooldown...');
      return;
    }

    isConnectingRef.current = true;
    cleanup();

    if (!chrome?.runtime?.connect) {
      handleError(new Error('Chrome runtime not available'));
      isConnectingRef.current = false;
      return;
    }

    try {
      const port = chrome.runtime.connect({ name: CONFIG.PORT_NAME });
      const immediateError = consumeRuntimeError();
      if (immediateError) throw new Error(immediateError);

      portRef.current = port;

      // Monitor for early connection errors
      let errorChecks = 0;
      errorCheckIntervalRef.current = setInterval(() => {
        errorChecks++;
        const err = consumeRuntimeError();

        if (err) {
          clearIntervalSafe(errorCheckIntervalRef);
          if (err.includes('Receiving end does not exist')) {
            console.warn('[Bridge] Background not ready, retrying...');
            cleanup();
            isConnectingRef.current = false;
            scheduleReconnect(connect);
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
        console.warn('[Bridge] Disconnected');
        isConnectingRef.current = false;

        const disconnectError = consumeRuntimeError();
        if (disconnectError) {
          handleError(new Error(disconnectError));
        } else {
          updateStatus('disconnected');
        }

        cleanup();

        // Only schedule reconnect if still mounted
        if (isMountedRef.current) {
          scheduleReconnect(connect);
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
          cleanup();
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
      consecutiveTimeoutsRef.current = 0;
      isConnectingRef.current = false;

      // Start health monitoring
      startHealthMonitor({
        bridge: bridgeInstance,
        pingIntervalRef,
        consecutivePingFailuresRef,
        pingInterval,
        setIsServiceWorkerAlive,
        onReconnectNeeded: triggerReconnect,
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
    connect();

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (!isMountedRef.current) return;
      if (isConnectingRef.current) return; // Prevent race condition

      const currentStatus = statusRef.current;
      const currentBridge = bridgeRef.current;

      if (currentStatus === 'disconnected' || currentStatus === 'error') {
        console.log('[Bridge] Tab visible, reconnecting...');
        retryCountRef.current = 0;
        connect();
      } else if (currentStatus === 'connected' && currentBridge) {
        currentBridge.ping().then((alive) => {
          // Check mounted before acting on async result
          if (!isMountedRef.current) return;
          if (!alive) {
            console.warn('[Bridge] Tab visible but unresponsive, reconnecting...');
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
      isMountedRef.current = false;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearTimeoutSafe(maxRetryCooldownRef);
      cleanup();
    };
  }, [connect, cleanup]);

  // Context value
  const contextValue = useMemo<BridgeContextValue>(
    () => ({ bridge, status, error, reconnect, isServiceWorkerAlive }),
    [bridge, status, error, reconnect, isServiceWorkerAlive],
  );

  return <BridgeContext.Provider value={contextValue}>{children}</BridgeContext.Provider>;
};
