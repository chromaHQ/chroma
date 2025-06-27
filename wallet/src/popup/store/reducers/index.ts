import { combineReducers } from '@reduxjs/toolkit';
import walletSlice from './walletReducer';

const rootReducer = combineReducers({
  wallet: walletSlice,
});

export default rootReducer;
