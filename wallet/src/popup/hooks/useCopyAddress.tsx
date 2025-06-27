import type { IWallet } from '@/store/reducers/walletReducer';
import { useCallback } from 'react';
import { toast } from 'sonner';

export function useCopyAddress(wallet: IWallet | undefined) {
  const copyAddress = useCallback(() => {
    if (!wallet) return;

    navigator.clipboard.writeText(wallet.address).then(
      () => {
        toast.success('Address copied to clipboard', {
          duration: 1000,
          position: 'top-center',
        });
      },
      (err) => {
        console.error('Failed to copy address: ', err);
      },
    );
  }, [wallet]);

  return copyAddress;
}
