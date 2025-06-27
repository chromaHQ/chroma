import { useState, useEffect, useCallback, useMemo } from 'react';
import { useQuery } from '../useQuery';

interface BalanceInfo {
  free: string;
  total: string;
  transferable: string;
  price: {
    price: number;
    formatted: {
      price: string;
    };
  };
  formatted: {
    free: string;
    total: string;
    transferable: string;
  };
}

interface UseBittensorBalanceReturn {
  balance: BalanceInfo | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

interface UseBittensorBalanceOptions {
  autoRefresh?: boolean;
  refreshInterval?: number;
  network?: 'mainnet' | 'testnet' | 'local';
}

export function useBittensorBalance(
  address: string | null,
  options: UseBittensorBalanceOptions = {},
): UseBittensorBalanceReturn {
  const { autoRefresh = false, refreshInterval = 30000, network = 'mainnet' } = options;

  const [balance, setBalance] = useState<BalanceInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { run } = useQuery();

  const fetchBalance = useCallback(async (): Promise<void> => {
    if (!address) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const balanceInfo = await run<BalanceInfo>('GetBalance', { network, address });
      setBalance(balanceInfo);
    } catch (err) {
      setError(`Failed to fetch balance: ${err instanceof Error ? err.message : 'Unknown error'}`);
      setBalance(null);
    } finally {
      setIsLoading(false);
    }
  }, [address, run, network]);

  const refetch = useCallback(async (): Promise<void> => {
    await fetchBalance();
  }, [fetchBalance]);

  useEffect(() => {
    if (address) {
      fetchBalance();
    } else if (!address) {
      setBalance(null);
      setError(null);
    }
  }, [address, fetchBalance]);

  useEffect(() => {
    if (!autoRefresh || !address) {
      return;
    }

    const interval = setInterval(() => {
      fetchBalance();
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [autoRefresh, refreshInterval, address, fetchBalance]);

  return {
    balance,
    isLoading,
    error,
    refetch,
  };
}

export function useFormattedBalance(
  balance: BalanceInfo | null,
  type: 'free' | 'total' | 'transferable' = 'total',
) {
  return balance?.formatted[type] || '0';
}

export function useBalanceFormatted(
  id: string | undefined,
  address: string | null,
  options: UseBittensorBalanceOptions & {
    format?: 'TAO' | 'RAO' | 'USD';
    usdPrice?: number;
  } = {},
) {
  const { format = 'TAO', usdPrice = 0, ...balanceOptions } = options;
  const { balance, ...rest } = useBittensorBalance(address, balanceOptions);

  const formattedBalance = useMemo(() => {
    if (!balance || !balance.formatted || !balance.total) {
      return null;
    }

    const taoAmount = parseFloat(balance.formatted?.total);

    switch (format) {
      case 'RAO':
        return balance.total;
      case 'USD':
        return usdPrice > 0 ? (taoAmount * usdPrice).toFixed(2) : '0';
      case 'TAO':
      default:
        return balance.formatted.total;
    }
  }, [balance, format, usdPrice]);

  return {
    id,
    balance,
    formattedBalance,
    symbol: format,
    ...rest,
  };
}
