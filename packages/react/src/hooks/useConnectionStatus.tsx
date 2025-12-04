import { useContext } from 'react';
import { BridgeContext } from '../BridgeProvider';

export const useConnectionStatus = () => {
  const context = useContext(BridgeContext);
  return {
    status: context?.status,
    isServiceWorkerAlive: context?.isServiceWorkerAlive ?? false,
    reconnect: context?.reconnect,
  };
};
