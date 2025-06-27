import BottomNavigation from '@/components/BottomNavigation';
import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import {
  CardDescription,
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { useAppSelector } from '@/store/store';
import Lottie from 'lottie-react';
import { useNavigate } from 'react-router';
import { useCallback } from 'react';
import Gradient from '../../assets/animations/gradient.json';
import Gradient2 from '../../assets/animations/gradient2.json';

function CardAddFirst() {
  const navigate = useNavigate();

  const goToAddWallet = useCallback(() => {
    navigate('/add-wallet');
  }, [navigate]);

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="flex flex-col items-center gap-2">
        <CardTitle>1/2</CardTitle>
        <CardDescription>Seems you don't have a wallet yet</CardDescription>
        <Lottie className="max-w-[120px]" animationData={Gradient2} loop={true} height={100} />
      </CardHeader>
      <CardContent></CardContent>
      <CardFooter className="flex-col gap-2">
        <Button onClick={goToAddWallet} className="w-full cursor-pointer">
          Add my first wallet
        </Button>
      </CardFooter>
    </Card>
  );
}

function CardAddFirstStake() {
  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="flex flex-col items-center gap-2">
        <CardTitle>2/2</CardTitle>
        <CardDescription>Do your first stake</CardDescription>
      </CardHeader>
      <CardContent></CardContent>
      <CardFooter className="flex-col gap-2">
        <Button type="submit" disabled className="w-full cursor-pointer">
          Stake
        </Button>
      </CardFooter>
    </Card>
  );
}

export function HomePage() {
  const { wallets } = useAppSelector((state) => state.wallet);
  return (
    <Page className="flex flex-col">
      <div className="flex flex-col justify-center items-center gap-2 p-4">
        <Lottie className="max-w-[100px]" animationData={Gradient} loop={true} height={100} />
        <div className="text-center">
          <h2 className="text-lg">Welcome to your wallet</h2>
          <p className="text-sm opacity-50">Are you ready to start your journey?</p>
        </div>
      </div>

      <div className="flex flex-col items-center gap-2 p-4 bg-white">
        {!wallets?.length && <CardAddFirst />}
        <CardAddFirstStake />
      </div>
      <BottomNavigation active="home" />
    </Page>
  );
}
