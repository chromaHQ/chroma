import { useContext } from 'react';
import { BridgeContext } from '../BridgeProvider';

export const useConnectionStatus = () => {
  return useContext(BridgeContext)?.status;
};
