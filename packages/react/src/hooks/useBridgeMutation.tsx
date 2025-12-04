import { useState, useCallback, useRef } from 'react';
import { useBridge } from './useBridge';

interface UseBridgeMutationOptions {
  /** Timeout duration in ms. Default: 10000 */
  timeout?: number;
  /** Callback on successful mutation */
  onSuccess?: (data: unknown) => void;
  /** Callback on mutation error */
  onError?: (error: Error) => void;
  /** Number of retry attempts on failure. Default: 0 */
  retries?: number;
  /** Delay between retries in ms. Default: 1000 */
  retryDelay?: number;
}

interface UseBridgeMutationResult<Req, Res> {
  /** Execute the mutation */
  mutate: (payload?: Req) => Promise<Res>;
  /** The response data from the last successful mutation */
  data: Res | undefined;
  /** Whether a mutation is currently in progress */
  loading: boolean;
  /** Any error from the last mutation attempt */
  error: Error | undefined;
  /** Reset the mutation state */
  reset: () => void;
}

/**
 * Custom hook for executing mutations (write operations) via the bridge.
 * Unlike useBridgeQuery, this doesn't execute automatically - you call mutate() when ready.
 *
 * @param key The message key to send
 * @param options Mutation options
 * @returns { mutate, data, loading, error, reset }
 *
 * @example
 * const { mutate, loading, error } = useBridgeMutation<{ name: string }, User>('user:create');
 *
 * const handleSubmit = async (name: string) => {
 *   const newUser = await mutate({ name });
 *   console.log('Created user:', newUser);
 * };
 */
export function useBridgeMutation<Req = unknown, Res = unknown>(
  key: string,
  options: UseBridgeMutationOptions = {},
): UseBridgeMutationResult<Req, Res> {
  const { timeout, onSuccess, onError, retries = 0, retryDelay = 1000 } = options;

  const { bridge, status } = useBridge();

  const [data, setData] = useState<Res>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error>();

  const mutationIdRef = useRef(0);

  const mutate = useCallback(
    async (payload?: Req): Promise<Res> => {
      if (!bridge) {
        const err = new Error('Bridge is not initialized');
        setError(err);
        onError?.(err);
        throw err;
      }

      if (!bridge.isConnected) {
        const err = new Error('Bridge is not connected');
        setError(err);
        onError?.(err);
        throw err;
      }

      const currentMutationId = ++mutationIdRef.current;
      setLoading(true);
      setError(undefined);

      let lastError: Error | undefined;
      let attempts = 0;

      while (attempts <= retries) {
        try {
          const result = await bridge.send<Req, Res>(key, payload, timeout);

          // Only update state if this is still the latest mutation
          if (currentMutationId === mutationIdRef.current) {
            setData(result);
            setError(undefined);
            setLoading(false);
            onSuccess?.(result);
          }

          return result;
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
          attempts++;

          // If we have retries left and bridge is still connected, retry
          if (attempts <= retries && bridge.isConnected) {
            console.warn(
              `[Bridge] Mutation "${key}" failed (attempt ${attempts}/${retries + 1}), retrying in ${retryDelay}ms...`,
            );
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
          }
        }
      }

      // All retries exhausted
      if (currentMutationId === mutationIdRef.current) {
        setError(lastError);
        setLoading(false);
        onError?.(lastError!);
      }

      throw lastError;
    },
    [bridge, key, timeout, onSuccess, onError, retries, retryDelay],
  );

  const reset = useCallback(() => {
    setData(undefined);
    setError(undefined);
    setLoading(false);
  }, []);

  return { mutate, data, loading, error, reset };
}
