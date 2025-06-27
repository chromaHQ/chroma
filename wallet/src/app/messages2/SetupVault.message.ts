import { Inject, Message } from '@chroma/core';
import { EncryptionService } from '../services/encryption';
import { PasswordService } from '../services/password';

/**
 * Settup a new vault with empty payload but with a random iv encrypted with the password.
 */
@Message('SetupVault')
export class SetupVaultMessage {
  constructor(
    @Inject(EncryptionService) private readonly encryptionService: EncryptionService,
    @Inject(PasswordService) private readonly passwordService: PasswordService,
  ) {}

  async handle(password: string) {
    if (!password || password.length < 8) {
      throw new Error('Password must be at least 8 characters long.');
    }

    const hashedPassword = await this.passwordService.hashPassword(password);

    if (!hashedPassword) {
      throw new Error('Failed to hash the password.');
    }

    const response = await this.encryptionService.encrypt('{}', hashedPassword);

    if (!response || !response.iv || !response.encryptedData) {
      throw new Error('Failed to encrypt the vault.');
    }

    await this.passwordService.setPasswordInSessionStorage(hashedPassword);

    return response;
  }
}
