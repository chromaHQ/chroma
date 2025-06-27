import { Injectable } from '@chroma/core';

const SALT_LEN = 16;
const IV_LEN = 12;
const ITERATIONS = 100_000;

@Injectable()
export class EncryptionService {
  private crypto!: Crypto;

  /**
   * Encrypts the given data using AES-GCM with a derived key from the provided password.
   * @param data
   * @param password
   */
  async encrypt(data: string, password: string) {
    await this.init();

    const salt = this.crypto.getRandomValues(new Uint8Array(SALT_LEN));
    const iv = this.crypto.getRandomValues(new Uint8Array(IV_LEN));
    const key = await this.deriveKey(password, salt);
    const encoded = new TextEncoder().encode(JSON.stringify(data));
    const encrypted = await this.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

    return {
      iv: Buffer.from(iv).toString('hex'),
      salt: Buffer.from(salt).toString('hex'),
      encryptedData: Buffer.from(encrypted).toString('hex'),
    };
  }

  async decrypt(
    password: string,
    encrypted: string,
    iv: string,
    salt: string,
  ): Promise<boolean | null> {
    await this.init();
    const saltBytes = Buffer.from(salt, 'hex');
    const ivBytes = Buffer.from(iv, 'hex');
    const encryptedBytes = Buffer.from(encrypted, 'hex');
    const key = await this.deriveKey(password, saltBytes);

    try {
      await this.crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, key, encryptedBytes);

      return true;
    } catch (error) {
      console.error('Decryption failed:', error);
      return false;
    }
  }

  private async init() {
    if (typeof globalThis.crypto?.subtle !== 'undefined') {
      this.crypto = globalThis.crypto as Crypto;
    }
  }

  private async deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
    const keyMaterial = await this.crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveKey'],
    );

    return this.crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: ITERATIONS,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }
}
