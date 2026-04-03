/**
 * In-memory vault state.
 *
 * Holds the encryption key while the vault is unlocked.
 * The key exists only in process memory — never persisted to disk.
 */

let encryptionKey: CryptoKey | null = null;
let vaultUserId: string | null = null;
let secretKeyBytes: Uint8Array | null = null;

export function setEncryptionKey(key: CryptoKey, userId?: string): void {
  encryptionKey = key;
  if (userId) vaultUserId = userId;
}

/** Store the raw secret key bytes for IPC transfer (--eval daemon fork). */
export function setSecretKeyBytes(bytes: Uint8Array): void {
  secretKeyBytes = bytes;
}

/** Get raw secret key bytes for IPC transfer. Returns null if not stored. */
export function getSecretKeyBytes(): Uint8Array | null {
  return secretKeyBytes;
}

export function getUserId(): string | null {
  return vaultUserId;
}

export function getEncryptionKey(): CryptoKey | null {
  return encryptionKey;
}

export function isUnlocked(): boolean {
  return encryptionKey !== null;
}

export function lockVault(): void {
  encryptionKey = null;
  vaultUserId = null;
  // Zero raw key bytes before releasing reference — don't rely on GC timing
  secretKeyBytes?.fill(0);
  secretKeyBytes = null;
}
