import { useBridge } from '@chroma/react';
import { useCallback, useState } from 'react';

export function useQuery() {
  const { bridge } = useBridge();
  const [isLoading, setIsLoading] = useState(false);

  const run = useCallback(
    async function <T>(message: string, payload?: unknown) {
      if (!bridge) {
        throw new Error('Bridge is not initialized');
      }

      setIsLoading(true);
      await new Promise((resolve) => setTimeout(resolve, 1000));

      try {
        return await bridge.send<unknown, T>(message, payload);
      } catch (error) {
        console.error('Error:', error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [bridge],
  );

  return {
    run,
    isLoading,
  };
}
