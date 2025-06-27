import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import Lottie from 'lottie-react';
import Gradient from '../../assets/animations/gradient.json';
import Gradient1 from '../../assets/animations/gradient1.json';
import { useNavigate } from 'react-router';
import { useCallback, useEffect, useState } from 'react';
import { useGenerateWallet } from '@/hooks/onboarding/useGenerateWallet';
import { AnimatePresence, motion } from 'framer-motion';
import { Badge } from '@/components/ui/badge';
import { useTrimAddress } from '@/hooks/useTrimAddress';
import { toast } from 'sonner';

export function NewWallet() {
  const navigate = useNavigate();

  const importWallet = useCallback(() => {
    navigate('/home');
  }, [navigate]);

  const { run, isLoading } = useGenerateWallet();

  const [wallet, setWallet] = useState<{
    mnemonic: string;
    address: string;
    id: string;
    name: string;
    balance: number;
    encryptedMnemonic: string;
    iv: string;
    salt: string;
  } | null>(null);

  const trimAddress = useTrimAddress();

  useEffect(() => {
    if (wallet) {
      return;
    }

    run().then((res) => {
      if (res) {
        setWallet(res);
        toast.success('Wallet generated successfully');
      }
    });
  }, [run, wallet]);

  const copy = useCallback(() => {
    if (wallet) {
      navigator.clipboard
        .writeText(wallet.mnemonic)
        .then(() => {
          toast.success('Mnemonic copied to clipboard');
        })
        .catch((error) => {
          console.error('Failed to copy mnemonic:', error);
        });
    }
  }, [wallet]);

  return (
    <Page>
      <div className="flex flex-col pt-8 justify-between h-full rounded-xl">
        <div className="px-8 text-center flex-1 justify-center flex flex-col">
          <div className="flex items-center justify-center mb-4">
            <Lottie
              className="max-w-[120px]"
              animationData={wallet ? Gradient1 : Gradient}
              loop={true}
              height={100}
            />
          </div>

          {!wallet && <h2 className="text-sm font-base opensans">Generating your wallet</h2>}

          <AnimatePresence>
            {wallet && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ duration: 0.3 }}
                className="flex flex-col items-center gap-2 overflow-hidden"
              >
                {wallet && <h2 className="text-sm font-base opensans">Your wallet is ready</h2>}
                {wallet && (
                  <div className="flex flex-col items-center gap-2 text-over">
                    <Badge>{wallet.name}</Badge>
                    <Badge variant="outline">{trimAddress(wallet.address)}</Badge>
                  </div>
                )}
                <p className="text-sm text-gray-500">
                  Please write down your mnemonic and keep it safe. You will need it to access your
                  wallet.
                </p>
                {wallet && (
                  <div
                    onClick={copy}
                    className="bg-gray-100 p-4 rounded-lg mt-4 flex space-x-1 space-y-1 cursor-pointer flex-wrap"
                  >
                    {wallet.mnemonic.split(' ').map((item) => (
                      <Badge>{item}</Badge>
                    ))}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="flex flex-col bg-white w-full gap-4 mt-8 pt-4 px-8 rounded-xl pb-4 rounded-t-2xl">
          <Button
            loading={isLoading}
            onClick={importWallet}
            className="w-full cursor-pointer hover:scale-105 active:scale-95 transition-transform"
          >
            Continue
          </Button>
        </div>
      </div>
    </Page>
  );
}
