import { Inject, Message } from '@chroma/core';
import { WalletService } from '../services/wallet.service';

@Message('ValidateMnemonic')
export class ValidateMnemonicMessage {
  constructor(@Inject(WalletService) private readonly walletService: WalletService) {}

  handle(mnemonic: string) {
    return this.walletService.validateMnemonic(mnemonic);
  }
}
