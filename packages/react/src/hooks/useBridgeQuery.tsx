import { useEffect, useState } from 'react';
import { useBridge } from './useBridge';

/**
 * Custom hook to send a query to the bridge and return the response.
 * @param key
 * @param payload
 * @returns { data: Res | undefined, loading: boolean, error: unknown }
 */
export function useBridgeQuery<Res = unknown>(
  key: string,
  payload?: any,
): {
  data: Res | undefined;
  loading: boolean;
  error: unknown;
} {
  const { bridge } = useBridge();

  const [data, setData] = useState<Res>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    let mounted = true;
    setLoading(true);

    if (!bridge) {
      setError(new Error('Bridge is not initialized'));
      setLoading(false);
      return;
    }

    bridge
      .send(key, payload)
      .then((res) => mounted && setData(res as Res))
      .catch((e) => mounted && setError(e))
      .finally(() => mounted && setLoading(false));

    return () => {
      mounted = false;
    };
  }, [key, JSON.stringify(payload)]);

  return { data, loading, error };
}
