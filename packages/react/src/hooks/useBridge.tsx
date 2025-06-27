import { useContext } from 'react';
import { BridgeContext, BridgeContextValue } from '../BridgeProvider';

/**
 * Custom hook to access the bridge context.
 * @returns The bridge context value.
 */
export const useBridge = (): BridgeContextValue => {
  const context = useContext(BridgeContext);

  if (!context) {
    throw new Error('useBridge must be used inside <BridgeProvider>');
  }

  return context;
};
