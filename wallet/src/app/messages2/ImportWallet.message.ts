import { Inject, Message } from '@chroma/core';
import { WalletService } from '../services/wallet.service';

@Message('ImportWallet')
export class ImportWalletMessage {
  constructor(@Inject(WalletService) private readonly walletService: WalletService) {}

  handle(mnemonic: string) {
    return this.walletService.importWallet(mnemonic);
  }
}
