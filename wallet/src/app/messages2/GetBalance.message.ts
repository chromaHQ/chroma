import { Inject, Message } from '@chroma/core';
import { BalanceService } from '../services/balance';

interface Params {
  address: string;
}
@Message('GetBalance')
export class GetBalanceMessage {
  constructor(@Inject(BalanceService) private readonly balanceService: BalanceService) {}

  handle(payload: Params) {
    return this.balanceService.fetch(payload.address);
  }
}
