import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BridgeProvider } from '@chroma/react';
import { HashRouter, Route, Routes } from 'react-router';
import { OnboardingPage } from '@/pages/Onboarding';
import { Provider } from 'react-redux';
import { persistor, store } from '@/store/store';

import './index.css';
import { PersistGate } from 'redux-persist/integration/react';
import { SplashPage } from '@/pages/Splash';
import { HomePage } from '@/pages/Home';
import { AddWallet } from '@/pages/AddWallet';
import { NewWallet } from '@/pages/NewWallet';
import { Toaster } from '@/components/ui/sonner';
import { ImportWallet } from '@/pages/ImportWallet';
import { Settings } from '@/pages/Settings';
import { UnlockPage } from '@/pages/Unlock';
import { WalletsPage } from '@/pages/Wallets';
import { HistoryPage } from '@/pages/History';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider store={store}>
      <PersistGate loading={null} persistor={persistor}>
        <BridgeProvider maxRetries={3} retryAfter={1000}>
          <Toaster position="bottom-center" />
          <HashRouter>
            <Routes>
              <Route path="/" element={<SplashPage />} />
              <Route path="/onboarding" element={<OnboardingPage />} />
              <Route path="/home" element={<HomePage />} />
              <Route path="/add-wallet" element={<AddWallet />} />
              <Route path="/new-wallet" element={<NewWallet />} />
              <Route path="/import-wallet" element={<ImportWallet />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/unlock" element={<UnlockPage />} />
              <Route path="/wallet" element={<WalletsPage />} />
              <Route path="/history" element={<HistoryPage />} />
            </Routes>
          </HashRouter>
        </BridgeProvider>
      </PersistGate>
    </Provider>
  </StrictMode>,
);
