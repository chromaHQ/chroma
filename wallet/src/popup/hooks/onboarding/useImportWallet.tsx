import { useCallback } from 'react';
import { useQuery } from '../useQuery';
import { uniqueNamesGenerator, colors, animals } from 'unique-names-generator';
import { useAppDispatch, useAppSelector } from '@/store/store';
import { addWallet, setActiveWallet } from '@/store/reducers/walletReducer';

export function useImportWallet() {
  const { run: internal, isLoading } = useQuery();
  const dispatch = useAppDispatch();
  const wallets = useAppSelector((state) => state.wallet.wallets);

  const run = useCallback(
    async (mnemonic: string) => {
      const res = await internal<{
        address: string;
        encryptedMnemonic: string;
        iv: string;
        salt: string;
      }>('ImportWallet', mnemonic);

      if (!res) {
        throw new Error('Failed to generate wallet');
      }

      if (res) {
        // check if the wallet already exists
        const existingWallet = wallets.find((wallet) => wallet.address === res.address);

        if (existingWallet) {
          throw new Error('Wallet already exists');
        }

        const walletId = crypto.randomUUID();
        const wallet = {
          id: walletId,
          name: uniqueNamesGenerator({ dictionaries: [colors, animals], separator: ' ' }),
          encryptedMnemonic: res.encryptedMnemonic,
          iv: res.iv,
          salt: res.salt,
          address: res.address,
          balance: 0,
        };

        dispatch(addWallet(wallet));
        dispatch(setActiveWallet(wallet.id));
        return wallet;
      }
    },
    [dispatch, internal, wallets],
  );

  return {
    run,
    isLoading,
  };
}
