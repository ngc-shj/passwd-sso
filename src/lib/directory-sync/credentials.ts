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

const HEX64_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Resolve the 256-bit encryption key for directory-sync credentials.
 *
 * Priority:
 *  1. DIRECTORY_SYNC_MASTER_KEY (64-char hex)
 *  2. SHARE_MASTER_KEY_V1 or SHARE_MASTER_KEY (dev/test only)
 *
 * In production, DIRECTORY_SYNC_MASTER_KEY is mandatory.
 */
function getDirectorySyncKey(): Buffer {
  const hex = process.env.DIRECTORY_SYNC_MASTER_KEY?.trim();
  if (hex && HEX64_RE.test(hex)) return Buffer.from(hex, "hex");

  if (process.env.NODE_ENV === "production") {
    throw new Error("DIRECTORY_SYNC_MASTER_KEY required in production");
  }

  // dev/test fallback
  const fallback = (
    process.env.SHARE_MASTER_KEY_V1 ?? process.env.SHARE_MASTER_KEY
  )?.trim();
  if (fallback && HEX64_RE.test(fallback)) return Buffer.from(fallback, "hex");

  throw new Error(
    "No encryption key available for directory sync credentials",
  );
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
