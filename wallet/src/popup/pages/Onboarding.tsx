import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Lottie from 'lottie-react';
import Gradient from '../../assets/animations/gradient.json';
import { useSetPassword } from '@/hooks/onboarding/useSetPassword';
import { Label } from '@/components/ui/label';
import { AnimatePresence, motion } from 'framer-motion';
import { useSetupWallet } from '@/hooks/onboarding/useSetupWallet';

export function OnboardingPage() {
  const { setPassword, password, setConfirmPassword, passwordError, valid } = useSetPassword();
  const { run, isLoading } = useSetupWallet();

  return (
    <Page>
      <div className="flex flex-col pt-8 justify-between h-full rounded-xl">
        <div className="px-8 text-center">
          <h1 className="text-6xl">hi</h1>
          <h2 className="text-sm">
            Seems this is your first time, let's set up everything for you.
          </h2>
          <div className="flex items-center justify-center">
            <Lottie className="max-w-[250px]" animationData={Gradient} loop={true} height={250} />
          </div>

          <h2 className="text-sm opacity-50 mt-2">Set up a password to protect your wallet.</h2>
        </div>

        <div className="flex flex-col bg-white w-full gap-8 mt-8 pt-4 px-8 rounded-xl pb-4 rounded-t-2xl">
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <AnimatePresence>
              <Input
                onChange={setPassword}
                autoFocus
                type="password"
                className="w-full"
                id="password"
                placeholder="Enter a password"
              />
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

          <div className="flex flex-col gap-2">
            <Label htmlFor="confirm-password">Confirm your password</Label>

            <Input
              onChange={setConfirmPassword}
              type="password"
              className="w-full"
              id="confirm-password"
              placeholder="Confirm password"
            />
          </div>
          <Button
            loading={isLoading}
            disabled={!valid}
            onClick={() => run(password)}
            className="w-full cursor-pointer hover:scale-105 active:scale-95 transition-transform"
          >
            Continue
          </Button>
        </div>
      </div>
    </Page>
  );
}
