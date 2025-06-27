import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import Lottie from 'lottie-react';
import Gradient from '../../assets/animations/gradient.json';
import Gradient1 from '../../assets/animations/gradient1.json';
import { useNavigate } from 'react-router';
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Badge } from '@/components/ui/badge';
import { useTrimAddress } from '@/hooks/useTrimAddress';
import { toast } from 'sonner';
import { Textarea } from '@/components/ui/textarea';
import { useImportWalletValidation } from '@/hooks/onboarding/useImportWalletValidation';
import { useImportWallet } from '@/hooks/onboarding/useImportWallet';

export function ImportWallet() {
  const navigate = useNavigate();
  const { setMnemonic, mnemonic, error, valid } = useImportWalletValidation();
  const { run, isLoading } = useImportWallet();

  const [wallet, setWallet] = useState<{
    encryptedMnemonic: string;
    iv: string;
    salt: string;
    address: string;
    id: string;
    name: string;
    balance: number;
  } | null>(null);

  const importWallet = async () => {
    if (wallet) {
      navigate('/home');
      return;
    }

    try {
      const wallet = await run(mnemonic);

      if (!wallet) {
        throw new Error('Failed to import wallet');
      }

      setWallet(wallet);
    } catch (err) {
      console.error('Error importing wallet:', err);
      toast.error('Failed to import wallet. Please check your mnemonic and try again.');
    }
  };

  const trimAddress = useTrimAddress();

  useEffect(() => {
    if (error) {
      toast.error(error);
      return;
    }
  }, [error]);

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

          <div className="flex flex-col items-center gap-2 mb-4">
            <h2 className="text-sm font-base opensans bold">Please paste your mnemonic here</h2>
            <Textarea
              onChange={setMnemonic}
              placeholder="foo bar ..."
              className={`resize-none border ${error ? 'border-red-500' : ''} ${valid ? 'border-green-500' : ''}`}
            >
              {mnemonic}
            </Textarea>
          </div>

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
                  Your wallet is now imported and ready to use. You can view it in the wallet list.
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="flex flex-col bg-white w-full gap-4 mt-8 pt-4 px-8 rounded-xl pb-4 rounded-t-2xl">
          <Button
            loading={isLoading}
            disabled={!valid || isLoading}
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
