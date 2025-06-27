import { Inject, Message } from '@chroma/core';
import { PasswordService } from '../services/password';

@Message('LockWallet')
export class LockWalletMessage {
  constructor(@Inject(PasswordService) private readonly passwordService: PasswordService) {}

  handle() {
    return this.passwordService.clearPasswordFromSessionStorage();
  }
}
