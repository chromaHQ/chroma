import { configureStore, isPlain, Tuple } from '@reduxjs/toolkit';
import {
  persistStore,
  persistReducer,
  FLUSH,
  PAUSE,
  PERSIST,
  PURGE,
  REGISTER,
  REHYDRATE,
} from 'redux-persist';
import type { Storage } from 'redux-persist';
import { useDispatch, useSelector } from 'react-redux';
import logger from 'redux-logger';

import rootReducer from './reducers';

const chromeStorage: Storage = {
  getItem: (key) =>
    new Promise((resolve) => {
      chrome.storage.local.get(key, (result) => {
        resolve((result[key] as string) ?? null);
      });
    }),

  setItem: (key, value) =>
    new Promise((resolve) => {
      console.debug('[chromeStorage.setItem]', key, value);
      chrome.storage.local.set({ [key]: value }, () => resolve(null));
    }),

  removeItem: (key) =>
    new Promise((resolve) => {
      chrome.storage.local.remove(key, () => resolve(null));
    }),
};

const persistConfig = {
  key: 'tensor-wallet',
  storage: chromeStorage,
};

const persistedReducer = persistReducer(persistConfig, rootReducer);

export const store = configureStore({
  reducer: persistedReducer,
  middleware: (getDefaultMiddleware) =>
    new Tuple(
      ...getDefaultMiddleware({
        serializableCheck: {
          ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
          isSerializable: isPlain,
        },
      }),
      logger,
    ),
});

export const persistor = persistStore(store);

export type AppDispatch = typeof store.dispatch;
export type RootState = ReturnType<typeof store.getState>;

export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();
