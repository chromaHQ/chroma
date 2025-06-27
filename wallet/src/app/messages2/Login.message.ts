import { Inject, Message } from '@chroma/core';
import { EncryptionService } from '../services/encryption';
import { PasswordService } from '../services/password';

interface Params {
  iv: string;
  salt: string;
  encrypted: string;
  password: string;
}

@Message('Login')
export class LoginMessage {
  constructor(
    @Inject(EncryptionService) private readonly encryptionService: EncryptionService,
    @Inject(PasswordService) private readonly passwordService: PasswordService,
  ) {}

  async handle({ password, salt, encrypted, iv }: Params) {
    const hashedPassword = await this.passwordService.hashPassword(password);
    const res = await this.encryptionService.decrypt(hashedPassword, encrypted, iv, salt);

    if (!res) {
      return false;
    }

    await this.passwordService.setPasswordInSessionStorage(hashedPassword);

    return res;
  }
}
