import { useEffect, useState, useRef, useCallback } from 'react';
import { useBridge } from './useBridge';

interface UseBridgeQueryOptions {
  /** Whether to automatically refetch when bridge reconnects. Default: true */
  refetchOnReconnect?: boolean;
  /** Whether to skip the query entirely. Default: false */
  skip?: boolean;
  /** Timeout duration in ms. Default: 10000 */
  timeout?: number;
}

interface UseBridgeQueryResult<Res> {
  data: Res | undefined;
  loading: boolean;
  error: unknown;
  refetch: () => Promise<void>;
}

/**
 * Custom hook to send a query to the bridge and return the response.
 * Automatically waits for bridge connection and retries on reconnect.
 * @param key The message key to send
 * @param payload Optional payload to send with the message
 * @param options Query options
 * @returns { data, loading, error, refetch }
 */
export function useBridgeQuery<Res = unknown>(
  key: string,
  payload?: any,
  options: UseBridgeQueryOptions = {},
): UseBridgeQueryResult<Res> {
  const { refetchOnReconnect = true, skip = false, timeout } = options;
  const { bridge, status } = useBridge();

  const [data, setData] = useState<Res>();
  const [loading, setLoading] = useState(!skip);
  const [error, setError] = useState<unknown>();

  // Track previous status to detect reconnections
  const prevStatusRef = useRef(status);
  const fetchIdRef = useRef(0);

  const executeQuery = useCallback(async () => {
    if (skip) {
      setLoading(false);
      return;
    }

    if (!bridge || !bridge.isConnected) {
      // Don't set error here - we'll retry when connected
      return;
    }

    const currentFetchId = ++fetchIdRef.current;
    setLoading(true);
    setError(undefined);

    try {
      const res = await bridge.send<typeof payload, Res>(key, payload, timeout);
      // Only update if this is still the latest fetch
      if (currentFetchId === fetchIdRef.current) {
        setData(res);
        setError(undefined);
      }
    } catch (e) {
      if (currentFetchId === fetchIdRef.current) {
        setError(e);
      }
    } finally {
      if (currentFetchId === fetchIdRef.current) {
        setLoading(false);
      }
    }
  }, [bridge, key, payload, skip, timeout]);

  // Execute query when bridge becomes connected or params change
  useEffect(() => {
    if (skip) {
      setLoading(false);
      return;
    }

    if (status === 'connected' && bridge?.isConnected) {
      executeQuery();
    } else if (status === 'connecting') {
      setLoading(true);
    } else if (status === 'disconnected' || status === 'error') {
      // Keep existing data but mark as potentially stale
      setLoading(false);
    }
  }, [status, bridge?.isConnected, key, JSON.stringify(payload), skip, executeQuery]);

  // Handle reconnection - refetch if enabled
  useEffect(() => {
    const wasDisconnected =
      prevStatusRef.current === 'disconnected' ||
      prevStatusRef.current === 'error' ||
      prevStatusRef.current === 'reconnecting';
    const isNowConnected = status === 'connected';

    if (refetchOnReconnect && wasDisconnected && isNowConnected && !skip) {
      executeQuery();
    }

    prevStatusRef.current = status;
  }, [status, refetchOnReconnect, skip, executeQuery]);

  const refetch = useCallback(async () => {
    await executeQuery();
  }, [executeQuery]);

  return { data, loading, error, refetch };
}
