import { Inject, Injectable } from '@chroma/core';
import {
  cryptoWaitReady,
  encodeAddress,
  mnemonicGenerate,
  mnemonicToMiniSecret,
  sr25519PairFromSeed,
  mnemonicValidate,
} from '@polkadot/util-crypto';

import { EncryptionService } from './encryption';
import { PasswordService } from './password';

@Injectable()
export class WalletService {
  private isWasmInitialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(
    @Inject(PasswordService) private readonly passwordService: PasswordService,
    @Inject(EncryptionService) private readonly encryptionService: EncryptionService,
  ) {}

  /**
   * Bittensor SS58 format for addresses
   */
  private readonly BITTENSOR_SS58_FORMAT = 42;

  /**
   * Derives a Bittensor address from a mnemonic phrase.
   * @param mnemonic
   * @returns The Bittensor address derived from the mnemonic
   */
  private getAddress(mnemonic: string): string {
    const seed2 = mnemonicToMiniSecret(mnemonic);
    const keypair2 = sr25519PairFromSeed(seed2);
    return encodeAddress(keypair2.publicKey, this.BITTENSOR_SS58_FORMAT);
  }

  /**
   * Imports a Bittensor wallet using a mnemonic phrase.
   * @param mnemonic
   * @returns An object containing the address and encrypted mnemonic
   */
  async importWallet(mnemonic: string) {
    await this.initWasm();

    const { isValid } = this.validateMnemonic(mnemonic);

    if (!isValid) {
      throw new Error('Invalid mnemonic');
    }

    const address = this.getAddress(mnemonic);
    const password = await this.passwordService.getPasswordFromSessionStorage();

    if (!password) {
      throw new Error('Vault locked. Please unlock the vault to import the wallet.');
    }

    const encryptedMnemonic = await this.encryptionService.encrypt(mnemonic, password);

    return {
      address,
      mnemonic,
      iv: encryptedMnemonic.iv,
      salt: encryptedMnemonic.salt,
      encryptedMnemonic: encryptedMnemonic.encryptedData,
    };
  }

  /**
   * Generate a new Bittensor wallet
   * @
   */
  async generateWallet(): Promise<{
    iv: string;
    salt: string;
    address: string;
    mnemonic: string;
    encryptedMnemonic: string;
  }> {
    await this.initWasm();
    const mnemonic = mnemonicGenerate(12);
    const address = this.getAddress(mnemonic);

    const password = await this.passwordService.getPasswordFromSessionStorage();

    if (!password) {
      throw new Error('Vault locked. Please unlock the vault to import the wallet.');
    }

    const encryptedMnemonic = await this.encryptionService.encrypt(mnemonic, password);

    return {
      address,
      mnemonic,
      iv: encryptedMnemonic.iv,
      salt: encryptedMnemonic.salt,
      encryptedMnemonic: encryptedMnemonic.encryptedData,
    };
  }

  /**
   * Validate a mnemonic phrase
   * @returns An object indicating whether the mnemonic is valid
   */
  validateMnemonic(mnemonic: string) {
    const isValid = mnemonicValidate(mnemonic.trim().toLowerCase());
    return { isValid };
  }

  /**
   * Encrypt a mnemonic phrase
   * @returns An object containing the encrypted mnemonic, IV, and salt
   */
  async encryptMnemonic(
    mnemonic: string,
    password: string,
  ): Promise<{
    encryptedMnemonic: string;
    iv: string;
    salt: string;
  }> {
    const { isValid } = this.validateMnemonic(mnemonic);

    if (!isValid) {
      throw new Error('Invalid mnemonic');
    }

    const { encryptedData, iv, salt } = await this.encryptionService.encrypt(mnemonic, password);

    return {
      encryptedMnemonic: encryptedData,
      iv,
      salt,
    };
  }

  /**
   * Initializes the WASM crypto library if it hasn't been initialized yet.
   * @returns A promise that resolves when the WASM crypto library is initialized.
   */
  private async initWasm(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._initWasm();
    return this.initPromise;
  }

  /**
   * Internal method to initialize the WASM crypto library.
   * This method is called by `initWasm` and ensures that the WASM crypto library is initialized only once.
   */
  private async _initWasm(): Promise<void> {
    if (this.isWasmInitialized) {
      return;
    }

    try {
      await cryptoWaitReady();
      this.isWasmInitialized = true;
      console.log('WASM crypto initialized successfully');
    } catch (error) {
      console.error('Failed to initialize WASM crypto:', error);
      throw new Error('Failed to initialize cryptographic functions');
    }
  }
}
