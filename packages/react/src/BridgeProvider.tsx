import { useEffect, useState, createContext, useCallback, useMemo, useRef } from 'react';

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

interface Bridge {
  send: <Req = unknown, Res = unknown>(key: string, payload?: Req) => Promise<Res>;
  broadcast: (key: string, payload: any) => void;
  on: (key: string, handler: (payload: any) => void) => void;
  off: (key: string, handler: (payload: any) => void) => void;
  isConnected: boolean;
}

export interface BridgeContextValue {
  bridge: Bridge | null;
  status: ConnectionStatus;
  error: Error | null;
  reconnect: () => void;
}

export const BridgeContext = createContext<BridgeContextValue | null>(null);

interface Props {
  children: React.ReactNode;
  retryAfter?: number;
  maxRetries?: number;
  onConnectionChange?: (status: ConnectionStatus) => void;
  onError?: (error: Error) => void;
}

export const BridgeProvider: React.FC<Props> = ({
  children,
  retryAfter = 1500,
  maxRetries = 5,
  onConnectionChange,
  onError,
}) => {
  const [bridge, setBridge] = useState<Bridge | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [error, setError] = useState<Error | null>(null);

  const portRef = useRef<chrome.runtime.Port | null>(null);

  const pendingRef = useRef(
    new Map<string, { resolve: (data: any) => void; reject: (error: Error) => void }>(),
  );

  const eventListenersRef = useRef(new Map<string, Set<(payload: any) => void>>());

  const uidRef = useRef(0);
  const reconnectTimeoutRef = useRef<any>(null);
  const retryCountRef = useRef(0);
  const isConnectingRef = useRef(false);
  const errorCheckIntervalRef = useRef<any>(null);

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

    if (portRef.current) {
      try {
        portRef.current.disconnect();
      } catch (e) {
        // Ignore disconnect errors
      }

      portRef.current = null;
    }

    pendingRef.current.forEach(({ reject }) => {
      reject(new Error('Bridge disconnected'));
    });

    pendingRef.current.clear();
    eventListenersRef.current.clear();

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
          const { resolve, reject } = pendingRef.current.get(msg.id)!;

          if (msg.error) {
            reject(new Error(msg.error));
          } else {
            resolve(msg.data);
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
          const delay = retryAfter * Math.pow(2, retryCountRef.current - 1);
          reconnectTimeoutRef.current = setTimeout(connect, delay);
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
            pendingRef.current.set(id, { resolve, reject });

            // Add timeout for requests
            const timeout = setTimeout(() => {
              if (pendingRef.current.has(id)) {
                pendingRef.current.delete(id);
                reject(new Error('Request timeout'));
              }
            }, timeoutDuration);

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
                    clearTimeout(timeout);
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
              clearTimeout(timeout);
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

        isConnected: true,
      };

      setBridge(bridgeInstance);
      updateStatus('connected');
      setError(null);
      retryCountRef.current = 0;
      isConnectingRef.current = false;
    } catch (e) {
      isConnectingRef.current = false;
      const error = e instanceof Error ? e : new Error('Connection failed');
      handleError(error);

      if (retryCountRef.current < maxRetries) {
        retryCountRef.current++;
        reconnectTimeoutRef.current = setTimeout(connect, retryAfter);
      }
    }
  }, [retryAfter, maxRetries, handleError, updateStatus, cleanup]);

  const reconnect = useCallback(() => {
    retryCountRef.current = 0;

    updateStatus('connecting');
    connect();
  }, [connect, updateStatus]);

  useEffect(() => {
    connect();
    return cleanup;
  }, [connect, cleanup]);

  const contextValue = useMemo(
    (): BridgeContextValue => ({
      bridge,
      status,
      error,
      reconnect,
    }),
    [bridge, status, error, reconnect],
  );

  return <BridgeContext.Provider value={contextValue}>{children}</BridgeContext.Provider>;
};
