import { useCallback } from 'react';
import { useQuery } from '../useQuery';
import { uniqueNamesGenerator, colors, animals } from 'unique-names-generator';
import { useAppDispatch } from '@/store/store';
import { addWallet, setActiveWallet } from '@/store/reducers/walletReducer';

export function useGenerateWallet() {
  const { run: internal, isLoading } = useQuery();
  const dispatch = useAppDispatch();

  const run = useCallback(async () => {
    const res = await internal<{
      mnemonic: string;
      address: string;
      encryptedMnemonic: string;
      iv: string;
      salt: string;
    }>('GenerateWallet');

    if (!res) {
      throw new Error('Failed to generate wallet');
    }

    if (res) {
      const walletId = crypto.randomUUID();
      const wallet = {
        id: walletId,
        name: uniqueNamesGenerator({ dictionaries: [colors, animals], separator: ' ' }),
        address: res.address,
        balance: 0,
        encryptedMnemonic: res.encryptedMnemonic,
        iv: res.iv,
        salt: res.salt,
      };

      dispatch(addWallet(wallet));
      dispatch(setActiveWallet(wallet.id));

      return { ...wallet, mnemonic: res.mnemonic };
    }
  }, [dispatch, internal]);

  return {
    run,
    isLoading,
  };
}
