import { useEffect, useState, createContext, useCallback, useMemo, useRef } from 'react';

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

interface Bridge {
  send: <Req = unknown, Res = unknown>(key: string, payload?: Req) => Promise<Res>;
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

  const uidRef = useRef(0);
  const reconnectTimeoutRef = useRef<any>(null);
  const retryCountRef = useRef(0);
  const isConnectingRef = useRef(false);

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
      portRef.current = port;

      port.onMessage.addListener((msg) => {
        if (msg.id && pendingRef.current.has(msg.id)) {
          const { resolve } = pendingRef.current.get(msg.id)!;
          resolve(msg.data);
          pendingRef.current.delete(msg.id);
        }
      });

      port.onDisconnect.addListener(() => {
        console.warn('[Bridge] disconnected');
        isConnectingRef.current = false;

        if (chrome.runtime.lastError) {
          handleError(new Error(chrome.runtime.lastError.message));
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
        send: <Req, Res = unknown>(key: string, payload?: Req): Promise<Res> => {
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
            }, 10000);

            try {
              portRef.current.postMessage({ id, key, payload });
            } catch (e) {
              clearTimeout(timeout);
              pendingRef.current.delete(id);
              reject(e instanceof Error ? e : new Error('Send failed'));
            }
          });
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
