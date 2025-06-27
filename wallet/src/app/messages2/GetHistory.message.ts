import { Inject, Message } from '@chroma/core';
import { BalanceService } from '../services/balance';

interface Params {
  address: string;
}
@Message('GetHistory')
export class GetHistoryMessage {
  constructor(@Inject(BalanceService) private readonly balanceService: BalanceService) {}

  handle(payload: Params) {
    return this.balanceService.history(payload.address);
  }
}
