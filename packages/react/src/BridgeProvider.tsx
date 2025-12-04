import { useEffect, useState, createContext, useCallback, useMemo, useRef } from 'react';

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error' | 'reconnecting';

interface Bridge {
  send: <Req = unknown, Res = unknown>(
    key: string,
    payload?: Req,
    timeoutDuration?: number,
  ) => Promise<Res>;
  broadcast: (key: string, payload: any) => void;
  on: (key: string, handler: (payload: any) => void) => void;
  off: (key: string, handler: (payload: any) => void) => void;
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

export const BridgeContext = createContext<BridgeContextValue | null>(null);

interface Props {
  children: React.ReactNode;
  retryAfter?: number;
  maxRetries?: number;
  pingInterval?: number; // How often to ping the service worker (ms)
  maxRetryCooldown?: number; // How long to wait before resetting retry count (ms)
  onConnectionChange?: (status: ConnectionStatus) => void;
  onError?: (error: Error) => void;
}

export const BridgeProvider: React.FC<Props> = ({
  children,
  retryAfter = 1000,
  maxRetries = 10,
  pingInterval = 5000,
  maxRetryCooldown = 30000, // Reset retry count after 30s of max retries
  onConnectionChange,
  onError,
}) => {
  const [bridge, setBridge] = useState<Bridge | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [error, setError] = useState<Error | null>(null);
  const [isServiceWorkerAlive, setIsServiceWorkerAlive] = useState(false);

  const portRef = useRef<chrome.runtime.Port | null>(null);
  const maxRetryCooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const consecutivePingFailuresRef = useRef(0);

  const pendingRef = useRef(
    new Map<
      string,
      {
        resolve: (data: any) => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    >(),
  );

  const eventListenersRef = useRef(new Map<string, Set<(payload: any) => void>>());

  const uidRef = useRef(0);
  const reconnectTimeoutRef = useRef<any>(null);
  const retryCountRef = useRef(0);
  const isConnectingRef = useRef(false);
  const errorCheckIntervalRef = useRef<any>(null);
  const pingIntervalRef = useRef<any>(null);
  const consecutiveTimeoutsRef = useRef(0);

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

  const cleanup = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (errorCheckIntervalRef.current) {
      clearInterval(errorCheckIntervalRef.current);
      errorCheckIntervalRef.current = null;
    }

    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }

    if (portRef.current) {
      try {
        portRef.current.disconnect();
      } catch (e) {
        // Ignore disconnect errors
      }

      portRef.current = null;
    }

    pendingRef.current.forEach(({ reject, timeout }) => {
      clearTimeout(timeout);
      reject(new Error('Bridge disconnected'));
    });

    pendingRef.current.clear();
    eventListenersRef.current.clear();
    setIsServiceWorkerAlive(false);

    setBridge(null);
    isConnectingRef.current = false;
  }, []);

  const connect = useCallback(() => {
    if (isConnectingRef.current || retryCountRef.current >= maxRetries) {
      console.warn('[Bridge] Already connecting or max retries reached');
      return;
    }

    isConnectingRef.current = true;
    cleanup();

    if (!chrome?.runtime?.connect) {
      handleError(new Error('Chrome runtime not available'));
      return;
    }

    try {
      const port = chrome.runtime.connect({ name: 'chroma-bridge' });

      // Check for immediate connection errors
      if (chrome.runtime.lastError) {
        throw new Error(chrome.runtime.lastError.message || 'Failed to connect to extension');
      }

      portRef.current = port;

      let errorCheckCount = 0;
      const maxErrorChecks = 10; // Check for 1 second after connection
      errorCheckIntervalRef.current = setInterval(() => {
        errorCheckCount++;

        if (chrome.runtime.lastError) {
          const errorMessage = chrome.runtime.lastError.message;

          console.warn('[Bridge] Runtime error detected:', errorMessage);
          chrome.runtime.lastError;

          if (errorCheckIntervalRef.current) {
            clearInterval(errorCheckIntervalRef.current);
            errorCheckIntervalRef.current = null;
          }

          if (errorMessage?.includes('Receiving end does not exist')) {
            console.warn('[Bridge] Background script not ready, will retry connection');
            cleanup();
            isConnectingRef.current = false;

            if (retryCountRef.current < maxRetries) {
              retryCountRef.current++;
              const delay = retryAfter * Math.pow(2, retryCountRef.current - 1);
              reconnectTimeoutRef.current = setTimeout(connect, delay);
            }
          }
        }

        if (errorCheckCount >= maxErrorChecks) {
          if (errorCheckIntervalRef.current) {
            clearInterval(errorCheckIntervalRef.current);
            errorCheckIntervalRef.current = null;
          }
        }
      }, 100);

      port.onMessage.addListener((msg) => {
        // Handle request/response messages
        if (msg.id && pendingRef.current.has(msg.id)) {
          const pending = pendingRef.current.get(msg.id)!;

          // Clear the timeout since we got a response
          clearTimeout(pending.timeout);

          // Reset consecutive timeouts counter on successful response
          consecutiveTimeoutsRef.current = 0;

          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg.data);
          }

          pendingRef.current.delete(msg.id);
        }
        // Handle broadcast messages
        else if (msg.type === 'broadcast' && msg.key) {
          const listeners = eventListenersRef.current.get(msg.key);
          if (listeners) {
            listeners.forEach((handler) => {
              try {
                handler(msg.payload);
              } catch (error) {
                console.warn('[Bridge] Error in event handler:', error);
              }
            });
          }
        }
      });

      port.onDisconnect.addListener(() => {
        console.warn('[Bridge] disconnected');
        isConnectingRef.current = false;

        if (chrome.runtime.lastError) {
          handleError(
            new Error(chrome.runtime.lastError.message || 'Port disconnected with error'),
          );
          chrome.runtime.lastError;
        } else {
          updateStatus('disconnected');
        }

        cleanup();

        // Retry with exponential backoff
        if (retryCountRef.current < maxRetries) {
          retryCountRef.current++;
          const delay = Math.min(retryAfter * Math.pow(2, retryCountRef.current - 1), 30000); // Cap at 30s
          console.log(
            `[Bridge] Reconnecting in ${delay}ms (attempt ${retryCountRef.current}/${maxRetries})`,
          );
          updateStatus('reconnecting');
          reconnectTimeoutRef.current = setTimeout(connect, delay);
        } else {
          // Max retries reached - schedule a cooldown reset and retry
          console.warn(
            `[Bridge] Max retries (${maxRetries}) reached. Will retry after ${maxRetryCooldown}ms cooldown.`,
          );
          if (maxRetryCooldownRef.current) {
            clearTimeout(maxRetryCooldownRef.current);
          }
          maxRetryCooldownRef.current = setTimeout(() => {
            console.log(
              '[Bridge] Cooldown complete, resetting retry count and attempting reconnection...',
            );
            retryCountRef.current = 0;
            connect();
          }, maxRetryCooldown);
        }
      });

      const bridgeInstance: Bridge = {
        send: <Req, Res = unknown>(
          key: string,
          payload?: Req,
          timeoutDuration: number = 10000,
        ): Promise<Res> => {
          return new Promise((resolve, reject) => {
            if (!portRef.current) {
              reject(new Error('Bridge disconnected'));
              return;
            }

            const id = `msg${uidRef.current++}`;

            // Add timeout for requests
            const timeout = setTimeout(() => {
              if (pendingRef.current.has(id)) {
                pendingRef.current.delete(id);
                consecutiveTimeoutsRef.current++;

                const errorMessage = `Request timed out after ${timeoutDuration}ms for key: ${key} (id: ${id})`;
                console.warn(`[Bridge] ${errorMessage}`);

                // If we get multiple consecutive timeouts, the service worker is likely dead
                if (consecutiveTimeoutsRef.current >= 2 && status !== 'reconnecting') {
                  console.warn(
                    `[Bridge] ${consecutiveTimeoutsRef.current} consecutive timeouts detected, service worker may be unresponsive. Reconnecting...`,
                  );
                  setIsServiceWorkerAlive(false);
                  updateStatus('reconnecting');

                  // Reject all pending requests before reconnecting
                  pendingRef.current.forEach(
                    ({ reject: pendingReject, timeout: pendingTimeout }, pendingId) => {
                      if (pendingId !== id) {
                        clearTimeout(pendingTimeout);
                        pendingReject(new Error('Bridge reconnecting due to consecutive timeouts'));
                      }
                    },
                  );
                  pendingRef.current.clear();

                  // Force reconnect after a short delay
                  retryCountRef.current = 0;
                  isConnectingRef.current = false;
                  consecutiveTimeoutsRef.current = 0; // Reset before reconnect
                  setTimeout(() => {
                    cleanup();
                    connect();
                  }, 100);
                }

                reject(new Error(errorMessage));
              }
            }, timeoutDuration);
            pendingRef.current.set(id, { resolve, reject, timeout });

            try {
              portRef.current.postMessage({ id, key, payload });

              // Use setTimeout to check for runtime errors asynchronously
              setTimeout(() => {
                if (chrome.runtime.lastError) {
                  const errorMessage = chrome.runtime.lastError.message;
                  console.warn('[Bridge] Async runtime error after postMessage:', errorMessage);
                  // Clear the error to prevent unchecked runtime.lastError
                  chrome.runtime.lastError;

                  // If this message is still pending, reject it
                  if (pendingRef.current.has(id)) {
                    const pending = pendingRef.current.get(id);
                    if (pending) clearTimeout(pending.timeout);
                    pendingRef.current.delete(id);
                    reject(new Error(errorMessage || 'Async send failed'));
                  }
                }
              }, 0);

              // Also check for immediate runtime errors
              if (chrome.runtime.lastError) {
                throw new Error(chrome.runtime.lastError.message || 'Failed to send message');
              }
            } catch (e) {
              const pending = pendingRef.current.get(id);
              if (pending) clearTimeout(pending.timeout);
              pendingRef.current.delete(id);

              // Also check for runtime errors in catch block and clear them
              if (chrome.runtime.lastError) {
                console.warn(
                  '[Bridge] Runtime error during postMessage:',
                  chrome.runtime.lastError.message,
                );

                chrome.runtime.lastError;
              }

              reject(e instanceof Error ? e : new Error('Send failed'));
            }
          });
        },

        broadcast: (key: string, payload: any): void => {
          if (!portRef.current) {
            console.warn('[Bridge] Cannot broadcast - disconnected');
            return;
          }

          try {
            portRef.current.postMessage({ type: 'broadcast', key, payload });
          } catch (e) {
            console.warn('[Bridge] Broadcast failed:', e);
          }
        },

        on: (key: string, handler: (payload: any) => void): void => {
          let listeners = eventListenersRef.current.get(key);
          if (!listeners) {
            listeners = new Set();
            eventListenersRef.current.set(key, listeners);
          }
          listeners.add(handler);
        },

        off: (key: string, handler: (payload: any) => void): void => {
          const listeners = eventListenersRef.current.get(key);
          if (listeners) {
            listeners.delete(handler);
            if (listeners.size === 0) {
              eventListenersRef.current.delete(key);
            }
          }
        },

        ping: async (): Promise<boolean> => {
          try {
            // Use a short timeout for ping
            await bridgeInstance.send('__ping__', undefined, 2000);
            return true;
          } catch {
            return false;
          }
        },

        get isConnected() {
          return portRef.current !== null && status === 'connected';
        },
      };

      setBridge(bridgeInstance);
      updateStatus('connected');
      setIsServiceWorkerAlive(true);
      setError(null);
      retryCountRef.current = 0;
      consecutiveTimeoutsRef.current = 0;
      isConnectingRef.current = false;

      // Start ping interval to detect service worker health and auto-reconnect
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
      }
      consecutivePingFailuresRef.current = 0;
      pingIntervalRef.current = setInterval(async () => {
        if (bridgeInstance && portRef.current) {
          const alive = await bridgeInstance.ping();
          setIsServiceWorkerAlive(alive);

          if (!alive) {
            consecutivePingFailuresRef.current++;
            console.warn(
              `[Bridge] Service worker ping failed (${consecutivePingFailuresRef.current} consecutive failures)`,
            );

            // Auto-reconnect after 2 consecutive ping failures
            if (consecutivePingFailuresRef.current >= 2) {
              console.warn('[Bridge] Auto-reconnecting due to unresponsive service worker...');
              consecutivePingFailuresRef.current = 0;
              retryCountRef.current = 0;
              isConnectingRef.current = false;
              updateStatus('reconnecting');
              cleanup();
              connect();
            }
          } else {
            consecutivePingFailuresRef.current = 0;
          }
        }
      }, pingInterval);
    } catch (e) {
      isConnectingRef.current = false;
      const error = e instanceof Error ? e : new Error('Connection failed');
      handleError(error);

      if (retryCountRef.current < maxRetries) {
        retryCountRef.current++;
        reconnectTimeoutRef.current = setTimeout(connect, retryAfter);
      }
    }
  }, [retryAfter, maxRetries, pingInterval, handleError, updateStatus, cleanup]);

  const reconnect = useCallback(() => {
    retryCountRef.current = 0;
    consecutiveTimeoutsRef.current = 0;

    updateStatus('connecting');
    connect();
  }, [connect, updateStatus]);

  useEffect(() => {
    connect();

    // Auto-reconnect when tab becomes visible (handles service worker wake-up)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // If we're disconnected or had errors, try to reconnect
        if (status === 'disconnected' || status === 'error') {
          console.log('[Bridge] Tab became visible, attempting reconnection...');
          retryCountRef.current = 0;
          connect();
        } else if (status === 'connected' && bridge) {
          // If connected, verify connection is still alive
          bridge.ping().then((alive) => {
            if (!alive) {
              console.warn(
                '[Bridge] Tab became visible but service worker unresponsive, reconnecting...',
              );
              retryCountRef.current = 0;
              isConnectingRef.current = false;
              cleanup();
              connect();
            }
          });
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (maxRetryCooldownRef.current) {
        clearTimeout(maxRetryCooldownRef.current);
      }
      cleanup();
    };
  }, [connect, cleanup, status, bridge]);

  const contextValue = useMemo(
    (): BridgeContextValue => ({
      bridge,
      status,
      error,
      reconnect,
      isServiceWorkerAlive,
    }),
    [bridge, status, error, reconnect, isServiceWorkerAlive],
  );

  return <BridgeContext.Provider value={contextValue}>{children}</BridgeContext.Provider>;
};
