import { useContext, useSyncExternalStore } from 'react';
import { BridgeContext } from '../BridgeProvider';

export interface ConnectionStatusResult {
  /** Current connection status: 'connecting' | 'connected' | 'disconnected' | 'error' | 'reconnecting' */
  status: 'connecting' | 'connected' | 'disconnected' | 'error' | 'reconnecting' | undefined;
  /** Whether the bridge port is connected */
  isConnected: boolean;
  /** Whether the service worker is responding to pings */
  isServiceWorkerAlive: boolean;
  /** Manually trigger a reconnection */
  reconnect: (() => void) | undefined;
  /** Any connection error */
  error: Error | null | undefined;
  /** Whether the system is fully ready (bridge connected + optional store ready) */
  isReady: boolean;
  /** Whether the system is loading (bridge connecting/reconnecting OR store not ready) */
  isLoading: boolean;
}

interface StoreReadyMethods {
  onReady: (callback: () => void) => () => void;
  isReady: () => boolean;
}

/**
 * Hook to get unified connection status
 * @param store Optional store to include in readiness check
 */
export const useConnectionStatus = (store?: StoreReadyMethods): ConnectionStatusResult => {
  const context = useContext(BridgeContext);

  // Subscribe to store ready state if store is provided
  const storeReady = useSyncExternalStore(
    store?.onReady ?? (() => () => {}),
    store?.isReady ?? (() => true),
    () => false, // Server-side fallback
  );

  const bridgeConnected = context?.status === 'connected';
  const isReady = bridgeConnected && storeReady;
  const isLoading =
    !isReady &&
    (context?.status === 'connecting' ||
      context?.status === 'reconnecting' ||
      (bridgeConnected && !storeReady));

  return {
    status: context?.status,
    isConnected: bridgeConnected,
    isServiceWorkerAlive: context?.isServiceWorkerAlive ?? false,
    reconnect: context?.reconnect,
    error: context?.error,
    isReady,
    isLoading,
  };
};
