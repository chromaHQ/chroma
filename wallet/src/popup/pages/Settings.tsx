import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import Lottie from 'lottie-react';
import Gradient from '../../assets/animations/gradient.json';
import BottomNavigation from '@/components/BottomNavigation';
import { useCallback } from 'react';
import { useQuery } from '@/hooks/useQuery';
import { useDispatch } from 'react-redux';
import { setUnlocked } from '@/store/reducers/walletReducer';
import { useNavigate } from 'react-router';

export function Settings() {
  const { run, isLoading } = useQuery();
  const dispatch = useDispatch();
  const navigate = useNavigate();

  const lock = useCallback(async () => {
    await run('LockWallet');
    dispatch(setUnlocked(false));
    navigate('/');
  }, [dispatch, navigate, run]);

  return (
    <Page className="flex flex-col">
      <div className="flex items-center gap-2 p-4">
        <Lottie className="max-w-[40px]" animationData={Gradient} loop={true} height={40} />
        <h1 className="text-2xl m-4">Settings</h1>
      </div>

      <div className="flex flex-col items-center flex-1 p-8">
        <Button loading={isLoading} className="w-full max-w-sm cursor-pointer" onClick={lock}>
          Lock extension
        </Button>

        <div className="text-sm text-gray-500 mt-4">
          © {new Date().getFullYear()} Yeferson Licet. All rights reserved.
        </div>
      </div>

      <BottomNavigation active="settings" />
    </Page>
  );
}
