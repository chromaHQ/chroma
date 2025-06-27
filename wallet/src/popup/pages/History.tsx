import { Page } from '@/components/page';
import BottomNavigation from '@/components/BottomNavigation';
import { useAppDispatch, useAppSelector } from '@/store/store';
import Lottie from 'lottie-react';
import Empty from '../../assets/animations/empty.json';
import Gradient from '../../assets/animations/gradient.json';
import Gradient2 from '../../assets/animations/gradient1.json';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useEffect, useMemo } from 'react';
import { setActiveWallet, setWalletHistory } from '@/store/reducers/walletReducer';
import { ArrowDownLeft } from 'lucide-react';
import { useQuery } from '@/hooks/useQuery';
import { useTrimAddress } from '@/hooks/useTrimAddress';
import { AnimatePresence, motion } from 'framer-motion';

interface Transaction {
  id: string;
  to: { ss58: string; hex: string };
  from: { ss58: string; hex: string };
  network: string;
  block_number: number;
  timestamp: string;
  amount: string;
  fee: string;
  transaction_hash: string;
  extrinsic_id: string;
}

interface RowProps {
  tx: Transaction;
  currentAddress?: string;
}

function HistoryRow({ tx, currentAddress }: RowProps) {
  const trimAddress = useTrimAddress();

  const direction = useMemo(() => {
    if (!currentAddress) return 'neutral' as const;
    if (tx.from.ss58 === currentAddress) return 'sent' as const;
    if (tx.to.ss58 === currentAddress) return 'received' as const;
    return 'neutral' as const;
  }, [currentAddress, tx.from.ss58, tx.to.ss58]);

  const time = new Date(tx.timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });

  const date = new Date(tx.timestamp).toLocaleDateString();

  function formatAmount(raw: string) {
    return (BigInt(raw) / 10n ** 6n).toLocaleString();
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-foreground">
        <ArrowDownLeft className="h-5 w-5" />
      </div>
      <div className="flex flex-col text-sm text-muted-foreground">
        <span>
          {direction === 'sent'
            ? 'Sent to '
            : direction === 'received'
              ? 'Received from '
              : 'Transferred '}

          <span className="font-medium text-foreground">
            {direction === 'sent' ? trimAddress(tx.to.ss58) : trimAddress(tx.from.ss58)}
          </span>
        </span>
        <span className="text-xs text-muted-foreground">
          {date} • {time}
        </span>
      </div>
      <div className="ml-auto text-right text-sm font-semibold text-foreground">
        {formatAmount(tx.amount)}
      </div>
    </div>
  );
}

export function HistoryPage() {
  const dispatch = useAppDispatch();
  const wallets = useAppSelector((state) => state.wallet.wallets);
  const selectedWallet = useAppSelector((state) => state.wallet.activeWallet);

  const currentWallet = useMemo(
    () => wallets.find((wallet) => wallet.id === selectedWallet),
    [selectedWallet, wallets],
  );

  const { run, isLoading } = useQuery();

  useEffect(() => {
    if (currentWallet?.id) {
      run('GetHistory', currentWallet.address).then((res) => {
        if (res) {
          dispatch(
            setWalletHistory({
              id: currentWallet.id,
              history: res as Transaction[],
            }),
          );
        }
      });
    }
  }, [currentWallet?.address, currentWallet?.id, dispatch, run]);

  return (
    <Page>
      <div className="flex items-center gap-2 p-4">
        <Lottie className="max-w-[40px]" animationData={Gradient} loop={true} height={40} />
        <div className="justify-between flex-1 flex items-center">
          <h1 className="text-2xl m-4">History</h1>

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

      {!wallets?.length && (
        <div className="flex flex-col items-center justify-center">
          <Lottie className="max-w-[120px]" animationData={Empty} loop={true} height={100} />

          <h1 className="text-2xl font-bold">No wallets found</h1>
          <p className="text-muted-foreground">Let's</p>
        </div>
      )}

      <AnimatePresence>
        {((currentWallet?.history as Transaction[]) || []).length > 0 && !isLoading && (
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            initial={{ opacity: 0, y: 30 }}
            exit={{ opacity: 0, y: 30 }}
            transition={{ duration: 0.2 }}
          >
            <div className="flex flex-col divide-y">
              {((currentWallet?.history as Transaction[]) || []).map((tx) => (
                <HistoryRow key={tx.id} tx={tx} currentAddress={currentWallet?.address} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isLoading && (
          <motion.div
            animate={{ opacity: 1 }}
            initial={{ opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="flex flex-col items-center justify-center mt-8"
          >
            <Lottie className="max-w-[120px]" animationData={Gradient2} loop={true} height={100} />
            <h1 className="text-base font-bold">We are loading your history</h1>
          </motion.div>
        )}
      </AnimatePresence>

      <BottomNavigation active="history" />
    </Page>
  );
}
