import { useAppSelector } from '@/store/store';

export function useCurrentWallet() {
  const currentWallet = useAppSelector((state) =>
    state.wallet.wallets.find((w) => w.id === state.wallet.activeWallet),
  );

  return currentWallet;
}
