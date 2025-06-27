import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Lottie from 'lottie-react';
import Gradient from '../../assets/animations/gradient.json';
import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useState } from 'react';
import { useQuery } from '@/hooks/useQuery';
import { useAppSelector } from '@/store/store';
import { useDispatch } from 'react-redux';
import { setUnlocked } from '@/store/reducers/walletReducer';
import { useNavigate } from 'react-router';

export function UnlockPage() {
  const navigate = useNavigate();
  const dispatch = useDispatch();

  const [password, setPassword] = useState('');
  const vault = useAppSelector((state) => state.wallet.vault);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const { run, isLoading } = useQuery();

  const submit = useCallback(async () => {
    try {
      if (!vault) {
        setPasswordError('No vault found. Please set up your wallet first.');
        return;
      }

      const { encryptedData, iv, salt } = vault;

      const result = await run('Login', { password, encrypted: encryptedData, iv, salt });

      if (result) {
        setPasswordError(null);
        dispatch(setUnlocked(true));
        navigate('/home');
      } else {
        setPasswordError('Invalid password. Please try again.');
      }
    } catch (error) {
      console.error('Error unlocking wallet:', error);
      setPasswordError('An error occurred while unlocking. Please try again.');
    }
  }, [dispatch, navigate, password, run, vault]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    },
    [submit],
  );

  return (
    <Page>
      <div className="flex flex-col pt-8 h-full rounded-xl">
        <div className="px-8 text-center">
          <h1 className="text-6xl">hi</h1>
          <h2 className="text-sm">Welcome back</h2>
          <div className="flex items-center justify-center">
            <Lottie className="max-w-[250px]" animationData={Gradient} loop={true} height={250} />
          </div>
        </div>

        <div className="flex flex-col bg-white w-full gap-8 mt-8 pt-4 px-8 rounded-xl pb-4 rounded-t-2xl">
          <div className="flex flex-col gap-2">
            <AnimatePresence>
              <div className="flex w-full max-w-sm items-center gap-2">
                <Input
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                  onKeyDown={handleKeyDown}
                  type="password"
                  className="w-full"
                  id="password"
                  placeholder="Enter you password"
                />

                <Button
                  loading={isLoading}
                  onClick={submit}
                  className="cursor-pointer hover:scale-105 active:scale-95 transition-transform"
                >
                  Continue
                </Button>
              </div>
              {passwordError && (
                <motion.p
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  transition={{ duration: 0.3 }}
                  className="text-purple-500 text-sm mt-1"
                >
                  {passwordError}
                </motion.p>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </Page>
  );
}
