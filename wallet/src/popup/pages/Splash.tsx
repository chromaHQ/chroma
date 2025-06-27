import { Page } from '@/components/page';
import Lottie from 'lottie-react';
import Gradient1 from '../../assets/animations/gradient1.json';
import { AnimatePresence, motion } from 'framer-motion';
import { useAppDispatch, useAppSelector } from '@/store/store';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { setUnlocked } from '@/store/reducers/walletReducer';

export function SplashPage() {
  const { vaultSet, unlocked } = useAppSelector((state) => state.wallet);
  const navigate = useNavigate();
  const dispatch = useAppDispatch();

  async function validatePasswordIsPresent() {
    return new Promise((resolve) => {
      chrome.storage.session.get(['password'], (result) => {
        const passwordExists = result.password !== undefined && result.password !== null;
        resolve(passwordExists);
      });
    });
  }

  useEffect(() => {
    validatePasswordIsPresent().then((exists) => {
      if (!exists && unlocked) {
        dispatch(setUnlocked(false));
      }
    });
  }, [dispatch, unlocked]);

  useEffect(() => {
    if (!vaultSet) {
      navigate('/onboarding');
      return;
    }

    if (vaultSet) {
      if (unlocked) {
        navigate('/home');
      } else {
        navigate('/unlock');
      }
    }
  }, [navigate, unlocked, vaultSet]);

  return (
    <AnimatePresence>
      <Page>
        <motion.div className="flex h-full items-center justify-center">
          <Lottie className="max-w-[220px]" animationData={Gradient1} loop={true} height={100} />
        </motion.div>
      </Page>
    </AnimatePresence>
  );
}
