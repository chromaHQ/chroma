import { Inject, Message } from '@chroma/core';
import { WalletService } from '../services/wallet.service';

@Message('GenerateWallet')
export class GenerateWalletMessage {
  constructor(@Inject(WalletService) private readonly walletService: WalletService) {}

  handle() {
    return this.walletService.generateWallet();
  }
}
