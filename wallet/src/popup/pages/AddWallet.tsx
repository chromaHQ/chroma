import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import Lottie from 'lottie-react';
import Gradient from '../../assets/animations/gradient.json';
import { useNavigate } from 'react-router';
import { useCallback } from 'react';

export function AddWallet() {
  const navigate = useNavigate();

  const newWallet = useCallback(() => navigate('/new-wallet'), [navigate]);
  const importWallet = useCallback(() => navigate('/import-wallet'), [navigate]);

  return (
    <Page>
      <div className="flex flex-col pt-8 justify-between h-full rounded-xl">
        <div className="px-8 text-center flex-1 justify-center flex flex-col">
          <div className="flex items-center justify-center mb-4">
            <Lottie className="max-w-[120px]" animationData={Gradient} loop={true} height={100} />
          </div>

          <h1 className="text-6xl">hi</h1>
          <h2 className="text-sm">Let's set up a new wallet to unlock all our features</h2>
        </div>

        <div className="flex flex-col bg-white w-full gap-4 mt-8 pt-4 px-8 rounded-xl pb-4 rounded-t-2xl">
          <Button
            onClick={newWallet}
            className="w-full cursor-pointer hover:scale-105 active:scale-95 transition-transform"
          >
            Create a new wallet
          </Button>
          <Button
            onClick={importWallet}
            variant="secondary"
            className="w-full cursor-pointer hover:scale-105 active:scale-95 transition-transform"
          >
            Import existing mnemonic
          </Button>
        </div>
      </div>
    </Page>
  );
}
