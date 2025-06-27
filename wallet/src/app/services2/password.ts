import { Injectable } from '@chroma/core';

@Injectable()
export class PasswordService {
  /**
   * Hashes the password using SHA-256.
   * This is used to securely store the password in the vault.
   * @param password
   * @returns
   */
  async hashPassword(password: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Buffer.from(hashBuffer).toString('hex');
  }

  /**
   * Sets the password in session storage.
   * @param password
   * @returns
   */
  setPasswordInSessionStorage(password: string): Promise<void> {
    if (!password || password.length < 8) {
      throw new Error('Password must be at least 8 characters long.');
    }

    return new Promise((resolve) =>
      chrome.storage.session.set({ password }, () => {
        if (chrome.runtime.lastError) {
          console.error('Error setting password in session storage:', chrome.runtime.lastError);
          throw new Error('Failed to set password in session storage.');
        }
        resolve();
      }),
    );
  }

  /**
   * Retrieves the password from session storage.
   * @returns
   */
  getPasswordFromSessionStorage(): Promise<string | null> {
    return new Promise((resolve) => {
      chrome.storage.session.get('password', (result) => {
        if (chrome.runtime.lastError) {
          console.error('Error getting password from session storage:', chrome.runtime.lastError);
          resolve(null);
        } else {
          resolve(result.password || null);
        }
      });
    });
  }

  /**
   *  Clears the password from session storage.
   * @returns
   */
  clearPasswordFromSessionStorage(): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.session.remove('password', () => {
        if (chrome.runtime.lastError) {
          console.error('Error clearing password from session storage:', chrome.runtime.lastError);
          throw new Error('Failed to clear password from session storage.');
        }
        resolve();
      });
    });
  }
}
