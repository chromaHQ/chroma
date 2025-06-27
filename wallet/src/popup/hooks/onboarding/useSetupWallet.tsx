import { useCallback } from 'react';
import { useQuery } from '../useQuery';
import { useAppDispatch } from '@/store/store';
import { initVault } from '@/store/reducers/walletReducer';
import { useNavigate } from 'react-router';

const message = 'SetupVault';

interface SetupVaultResponse {
  iv: string;
  salt: string;
  encryptedData: string;
}

export function useSetupWallet() {
  const { run: internal, isLoading } = useQuery();
  const navigate = useNavigate();

  const dispatch = useAppDispatch();

  const run = useCallback(
    async (password: string) => {
      const res = await internal<SetupVaultResponse>(message, password);

      if (!res) {
        throw new Error('Failed to set up wallet');
      }

      dispatch(
        initVault({
          iv: res.iv,
          salt: res.salt,
          encryptedData: res.encryptedData,
        }),
      );

      navigate('/home');
    },
    [dispatch, internal, navigate],
  );

  return {
    run,
    isLoading,
  };
}
