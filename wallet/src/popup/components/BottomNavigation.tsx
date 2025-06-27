import { Home, Wallet, History, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';
import { NavLink } from 'react-router';
import Lottie from 'lottie-react';
import Bottom from '../../assets/animations/bottom.json';
export default function BottomNavigation({
  className,
  active,
}: {
  className?: string;
  active?: string;
}) {
  const navItems = [
    { to: '/home', label: 'Home', icon: Home, active: active === 'home' },
    { to: '/wallet', label: 'Wallet', icon: Wallet, active: active === 'wallet' },
    { to: '/history', label: 'History', icon: History, active: active === 'history' },
    { to: '/settings', label: 'Settings', icon: Settings, active: active === 'settings' },
  ];

  return (
    <>
      <div className="fixed -bottom-[130px] z-10">
        <Lottie className="max-w-[375px]" animationData={Bottom} loop={true} height={250} />
      </div>
      <nav
        className={cn(
          'fixed bottom-0 border-t left-1/2 -translate-x-1/2 max-w-[375px] w-full z-50 h-16 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60',
          'flex items-center justify-around shadow-md',
          className,
        )}
      >
        {navItems.map(({ to, label, icon: Icon, active }) => (
          <NavLink
            key={to}
            to={to}
            className={() =>
              cn(
                buttonVariants({ variant: 'link', size: 'icon' }),
                'flex flex-col gap-1 text-muted-foreground transition-none hover:bg-none hover:scale-105 transation-transform',
                active ? 'text-purple-800 font-bold' : 'text-muted-foreground',
              )
            }
          >
            <Icon className="h-5 w-5" aria-hidden="true" />
            <span className="text-[11px] leading-tight font-medium tracking-wide">{label}</span>
          </NavLink>
        ))}
      </nav>
    </>
  );
}
