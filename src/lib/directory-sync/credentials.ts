/**
 * Encrypt / decrypt provider credentials for Directory Sync configs.
 *
 * Uses a dedicated DIRECTORY_SYNC_MASTER_KEY (required in production).
 * Dev/test falls back to SHARE_MASTER_KEY_V1 / SHARE_MASTER_KEY.
 *
 * AAD (Additional Authenticated Data) = configId + ":" + tenantId
 * to bind ciphertext to a specific config row.
 */

import {
  encryptServerData,
  decryptServerData,
  type ServerEncryptedData,
} from "@/lib/crypto-server";
import { getKeyProviderSync } from "@/lib/key-provider";

/**
 * Resolve the 256-bit encryption key for directory-sync credentials.
 */
function getDirectorySyncKey(): Buffer {
  return getKeyProviderSync().getKeySync("directory-sync");
}

/** Build AAD buffer that binds ciphertext to a specific config row. */
function buildAad(configId: string, tenantId: string): Buffer {
  return Buffer.from(`${configId}:${tenantId}`);
}

/**
 * Encrypt plaintext credentials JSON for storage in DirectorySyncConfig.
 */
export function encryptCredentials(
  plaintext: string,
  configId: string,
  tenantId: string,
): ServerEncryptedData {
  const key = getDirectorySyncKey();
  const aad = buildAad(configId, tenantId);
  return encryptServerData(plaintext, key, aad);
}

/**
 * Decrypt credentials stored in DirectorySyncConfig.
 */
export function decryptCredentials(
  encrypted: ServerEncryptedData,
  configId: string,
  tenantId: string,
): string {
  const key = getDirectorySyncKey();
  const aad = buildAad(configId, tenantId);
  return decryptServerData(encrypted, key, aad);
}
