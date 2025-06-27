import { Page } from '@/components/page';
import BottomNavigation from '@/components/BottomNavigation';
import { useAppDispatch, useAppSelector } from '@/store/store';
import Lottie from 'lottie-react';
import Empty from '../../assets/animations/empty.json';
import Gradient from '../../assets/animations/gradient1.json';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useEffect, useMemo } from 'react';
import { setActiveWallet, setTaoPrice, setWalletBalance } from '@/store/reducers/walletReducer';
import NumberFlow from '@number-flow/react';
import { useBalanceFormatted } from '@/hooks/wallets/useBalance';
import WalletActionsBar from '@/components/WalletActionBar';
import { useCurrentWallet } from '@/hooks/wallets/useCurrentWallet';
import { useCopyAddress } from '@/hooks/useCopyAddress';

export function WalletsPage() {
  const dispatch = useAppDispatch();
  const wallets = useAppSelector((state) => state.wallet.wallets);
  const currentWallet = useCurrentWallet();

  const { taoPrice } = useAppSelector((state) => state.wallet);
  const copyAddress = useCopyAddress(currentWallet);

  const balance = useBalanceFormatted(currentWallet?.id, currentWallet?.address || '');

  useEffect(() => {
    if (
      !balance.isLoading &&
      balance.formattedBalance &&
      currentWallet?.balance !== parseFloat(balance.balance?.free || '0')
    ) {
      dispatch(
        setWalletBalance({
          id: balance.id!,
          balance: parseFloat(balance.balance?.free || '0'),
        }),
      );

      dispatch(setTaoPrice(balance.balance?.price.price || 0));
    }
  }, [
    balance.balance?.free,
    balance.balance?.price.price,
    balance.formattedBalance,
    balance.id,
    balance.isLoading,
    currentWallet?.balance,
    dispatch,
  ]);

  const walletBalance = useMemo(() => {
    return Number(currentWallet?.balance ?? '0') / 1e9;
  }, [currentWallet?.balance]);

  const formatedUsdBalance = useMemo(() => {
    return (taoPrice ?? 0) * walletBalance;
  }, [taoPrice, walletBalance]);

  return (
    <Page>
      <div className="flex items-center gap-2 p-4">
        <Lottie className="max-w-[40px]" animationData={Gradient} loop={true} height={40} />
        <div className="justify-between flex-1 flex items-center">
          <h1 className="text-2xl m-4">Wallet</h1>
          {wallets?.length > 0 && (
            <Select
              onValueChange={(value) => {
                dispatch(setActiveWallet(value));
              }}
              defaultValue={currentWallet?.id}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder={currentWallet?.name} />
              </SelectTrigger>
              <SelectContent>
                {wallets.map((wallet) => (
                  <SelectItem key={wallet.id} value={wallet.id}>
                    {wallet.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {wallets?.length > 0 && (
        <div className="flex flex-col items-center justify-center">
          <NumberFlow className="text-4xl font-bold" prefix="τ " value={walletBalance}></NumberFlow>
          {formatedUsdBalance !== null && (
            <NumberFlow
              className="text-lg font-bold text-green-500"
              format={{
                notation: 'compact',
                style: 'currency',
                currency: 'USD',
              }}
              value={formatedUsdBalance!}
            ></NumberFlow>
          )}
          <div onClick={copyAddress} className="text-muted-foreground text-sm cursor-pointer">
            {currentWallet?.address.slice(0, 6)}...{currentWallet?.address.slice(-4)}
          </div>
        </div>
      )}

      <div className="p-8">
        <WalletActionsBar />
      </div>

      {!wallets?.length && (
        <div className="flex flex-col items-center justify-center">
          <Lottie className="max-w-[120px]" animationData={Empty} loop={true} height={100} />

          <h1 className="text-2xl font-bold">No wallets found</h1>
          <p className="text-muted-foreground">Let's</p>
        </div>
      )}
      <BottomNavigation active="wallet" />
    </Page>
  );
}
