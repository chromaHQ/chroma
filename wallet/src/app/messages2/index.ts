import { Provider } from '@chroma/core';
import { SetupVaultMessage } from './SetupVault.message';
import { EncryptionService } from '../services/encryption';
import { GenerateWalletMessage } from './GenerateWallet.message';
import { WalletService } from '../services/wallet.service';
import { ValidateMnemonicMessage } from './ValidateMnemonic.message';
import { ImportWalletMessage } from './ImportWallet.message';
import { PasswordService } from '../services/password';
import { LockWalletMessage } from './LockWallet.message';
import { LoginMessage } from './Login.message';
import { GetBalanceMessage } from './GetBalance.message';
import { BalanceService } from '../services/balance';
import { GetHistoryMessage } from './GetHistory.message';

@Provider({
  imports: [
    SetupVaultMessage,
    GenerateWalletMessage,
    ValidateMnemonicMessage,
    ImportWalletMessage,
    LockWalletMessage,
    LoginMessage,
    GetBalanceMessage,
    GetHistoryMessage,
  ],
  uses: [EncryptionService, WalletService, PasswordService, BalanceService],
})
export class MessageProvider {}
