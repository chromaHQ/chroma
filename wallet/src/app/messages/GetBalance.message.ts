import { Booteable, Message } from '@chroma/core';
import WalletService from '../services/wallet.service';
import BalanceService from '../services/balance.service';

interface Params {
  address: string;
}

@Message('GetBalance')
export default class GetBalanceMessage implements Booteable {
  constructor(
    private walletService: WalletService,
    private balanceService: BalanceService,
  ) {}

  boot() {
    console.log('GetBalanceMessage boot called', this.walletService, this.balanceService);
  }

  handle(payload: Params) {}
}
