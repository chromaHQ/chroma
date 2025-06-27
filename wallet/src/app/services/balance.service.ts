import type UserService from './user.service';
import WalletService from './wallet.service';

export default class BalanceService {
  constructor(
    private readonly walletService: WalletService,
    private readonly userService: UserService,
  ) {
    console.log('BalanceService constructor called', this.walletService);
  }
}
