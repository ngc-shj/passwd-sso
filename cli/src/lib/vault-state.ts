/**
 * In-memory vault state.
 *
 * Holds the encryption key while the vault is unlocked.
 * The key exists only in process memory — never persisted to disk.
 */

let encryptionKey: CryptoKey | null = null;

export function setEncryptionKey(key: CryptoKey): void {
  encryptionKey = key;
}

export function getEncryptionKey(): CryptoKey | null {
  return encryptionKey;
}

export function isUnlocked(): boolean {
  return encryptionKey !== null;
}

export function lockVault(): void {
  encryptionKey = null;
}
