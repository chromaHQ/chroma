import { ArrowUpRight, ArrowDownLeft, Shuffle, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router';
import { useCallback } from 'react';
import { useCurrentWallet } from '@/hooks/wallets/useCurrentWallet';
import { useCopyAddress } from '@/hooks/useCopyAddress';
import { toast } from 'sonner';

export default function WalletActionsBar() {
  const navigate = useNavigate();
  const currentWallet = useCurrentWallet();
  const copyAddress = useCopyAddress(currentWallet);
  const addWallet = useCallback(() => navigate('/add-wallet'), [navigate]);

  const soon = useCallback(() => {
    toast.error('This feature is coming soon!', {
      duration: 1000,
      position: 'top-center',
    });
  }, []);

  return (
    <div className="flex w-full max-w-full items-start justify-between gap-4">
      <Action onClick={soon} icon={ArrowUpRight} label="Send" />
      <Action onClick={copyAddress} icon={ArrowDownLeft} label="Receive" />
      <Action onClick={soon} icon={Shuffle} label="Swap" />
      <Action onClick={addWallet} icon={Plus} label="Add Wallet" />
    </div>
  );
}

interface ActionProps {
  icon: React.ComponentType<{ size?: number }>;
  label: string;
  onClick?: () => void;
}

function Action({ icon: Icon, label, onClick }: ActionProps) {
  return (
    <div className="flex flex-col items-center gap-1 text-center cursor-pointer">
      <Button
        variant="secondary"
        size="icon"
        onClick={onClick}
        className="h-14 w-14 cursor-pointer rounded-full transition-transform duration-150 ease-in-out hover:scale-105 active:scale-95"
      >
        <Icon size={20} />
      </Button>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
    </div>
  );
}
