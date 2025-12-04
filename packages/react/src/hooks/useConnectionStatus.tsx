import { useContext } from 'react';
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
}

export const useConnectionStatus = (): ConnectionStatusResult => {
  const context = useContext(BridgeContext);
  return {
    status: context?.status,
    isConnected: context?.status === 'connected',
    isServiceWorkerAlive: context?.isServiceWorkerAlive ?? false,
    reconnect: context?.reconnect,
    error: context?.error,
  };
};
