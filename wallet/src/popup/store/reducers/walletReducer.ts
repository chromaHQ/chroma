import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface IWallet {
  id: string;
  name: string;
  address: string;
  balance: number;
  encryptedMnemonic?: string;
  iv?: string;
  salt?: string;
  history?: unknown[];
}

type WalletState = {
  vault: {
    iv: string;
    salt: string;
    encryptedData: string;
  } | null;

  vaultSet: boolean;

  wallets: IWallet[];
  activeWallet: string | null;
  loading: boolean;
  unlocked?: boolean;
  taoPrice: number | null;
};

const initialState: WalletState = {
  vault: null,
  vaultSet: false,
  activeWallet: null,
  wallets: [],
  loading: false,
  unlocked: false,
  taoPrice: null,
};

const walletSlice = createSlice({
  name: 'wallet',
  initialState,
  reducers: {
    initVault: (
      state,
      action: PayloadAction<{
        iv: string;
        salt: string;
        encryptedData: string;
      }>,
    ) => {
      const { iv, salt, encryptedData } = action.payload;

      state.vault = {
        iv,
        salt,
        encryptedData,
      };

      state.vaultSet = true;

      return state;
    },

    addWallet: (
      state,
      action: PayloadAction<{
        id: string;
        name: string;
        address: string;
        balance: number;
        encryptedMnemonic?: string;
        iv?: string;
        salt?: string;
      }>,
    ) => {
      const { id, name, address, balance } = action.payload;

      const newWallet: IWallet = {
        id,
        name,
        address,
        balance,
        encryptedMnemonic: action.payload.encryptedMnemonic,
        salt: action.payload.salt,
        iv: action.payload.iv,
        history: [],
      };

      if (!state.wallets) {
        state.wallets = [];
      }

      state.wallets.push(newWallet);

      return state;
    },

    setActiveWallet: (state, action: PayloadAction<string | null>) => {
      const walletId = action.payload;

      if (walletId === null || state.wallets.some((wallet) => wallet.id === walletId)) {
        state.activeWallet = walletId;
      } else {
        console.warn(`Wallet with ID ${walletId} does not exist.`);
      }

      return state;
    },

    setLoading: (state, action: PayloadAction<boolean>) => {
      state.loading = action.payload;
      return state;
    },

    setUnlocked: (state, action: PayloadAction<boolean>) => {
      state.unlocked = action.payload;
      return state;
    },

    setTaoPrice: (state, action: PayloadAction<number | null>) => {
      state.taoPrice = action.payload;
      return state;
    },

    setWalletBalance: (state, action: PayloadAction<{ id: string; balance: number }>) => {
      const { id, balance } = action.payload;

      const wallet = state.wallets.find((w) => w.id === id);

      if (wallet) {
        wallet.balance = balance;
      } else {
        console.warn(`Wallet with ID ${id} does not exist.`);
      }

      return state;
    },

    setWalletHistory: (state, action: PayloadAction<{ id: string; history: unknown[] }>) => {
      const { id, history } = action.payload;

      const wallet = state.wallets.find((w) => w.id === id);

      if (wallet) {
        wallet.history = history;
      } else {
        console.warn(`Wallet with ID ${id} does not exist.`);
      }

      return state;
    },
  },
});

export const {
  initVault,
  addWallet,
  setLoading,
  setUnlocked,
  setTaoPrice,
  setActiveWallet,
  setWalletBalance,
  setWalletHistory,
} = walletSlice.actions;

export default walletSlice.reducer;
