/**
 * Server-side cryptography module for organization vault.
 *
 * Key hierarchy:
 *   ORG_MASTER_KEY (env, 256-bit hex)
 *     -> AES-256-GCM wrap -> per-org key (Organization.encryptedOrgKey)
 *       -> AES-256-GCM -> OrgPasswordEntry.encryptedBlob / encryptedOverview
 *
 * Uses node:crypto (NOT Web Crypto API — this runs server-side only).
 */

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits, recommended for GCM
const KEY_LENGTH = 32; // 256 bits
const AUTH_TAG_LENGTH = 16; // 128 bits

export interface ServerEncryptedData {
  ciphertext: string; // hex
  iv: string; // hex (24 chars)
  authTag: string; // hex (32 chars)
}

// ─── Master Key ──────────────────────────────────────────────────

function getMasterKey(): Buffer {
  const hex = process.env.ORG_MASTER_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "ORG_MASTER_KEY must be a 64-char hex string (256 bits)"
    );
  }
  return Buffer.from(hex, "hex");
}

// ─── Per-Org Key Management ─────────────────────────────────────

/** Generate a random 256-bit organization key. */
export function generateOrgKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

/** Wrap (encrypt) an org key with the master key. */
export function wrapOrgKey(orgKey: Buffer): ServerEncryptedData {
  const masterKey = getMasterKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const ciphertext = Buffer.concat([cipher.update(orgKey), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("hex"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

/** Unwrap (decrypt) an org key using the master key. */
export function unwrapOrgKey(wrapped: ServerEncryptedData): Buffer {
  const masterKey = getMasterKey();
  const iv = Buffer.from(wrapped.iv, "hex");
  const authTag = Buffer.from(wrapped.authTag, "hex");
  const ciphertext = Buffer.from(wrapped.ciphertext, "hex");

  const decipher = createDecipheriv(ALGORITHM, masterKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ─── Data Encryption / Decryption ───────────────────────────────

/** Encrypt plaintext JSON with an org key (AES-256-GCM). Optional AAD for binding context. */
export function encryptServerData(
  plaintext: string,
  orgKey: Buffer,
  aad?: Buffer
): ServerEncryptedData {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, orgKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  if (aad) cipher.setAAD(aad);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("hex"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

/** Decrypt ciphertext with an org key (AES-256-GCM). Optional AAD must match encryption. */
export function decryptServerData(
  encrypted: ServerEncryptedData,
  orgKey: Buffer,
  aad?: Buffer
): string {
  const iv = Buffer.from(encrypted.iv, "hex");
  const authTag = Buffer.from(encrypted.authTag, "hex");
  const ciphertext = Buffer.from(encrypted.ciphertext, "hex");

  const decipher = createDecipheriv(ALGORITHM, orgKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

// ─── Binary Data Encryption / Decryption (for file attachments) ─

export interface ServerEncryptedBinary {
  ciphertext: Buffer;
  iv: string; // hex
  authTag: string; // hex
}

/** Encrypt binary data (Buffer) with an org key (AES-256-GCM). Optional AAD for binding context. */
export function encryptServerBinary(
  data: Buffer,
  orgKey: Buffer,
  aad?: Buffer
): ServerEncryptedBinary {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, orgKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  if (aad) cipher.setAAD(aad);

  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext,
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

/** Decrypt binary data with an org key (AES-256-GCM). Optional AAD must match encryption. */
export function decryptServerBinary(
  encrypted: ServerEncryptedBinary,
  orgKey: Buffer,
  aad?: Buffer
): Buffer {
  const iv = Buffer.from(encrypted.iv, "hex");
  const authTag = Buffer.from(encrypted.authTag, "hex");

  const decipher = createDecipheriv(ALGORITHM, orgKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(encrypted.ciphertext),
    decipher.final(),
  ]);
}

// ─── Share Link Helpers ─────────────────────────────────────────

/** Generate a 32-byte random token as hex (64 chars). */
export function generateShareToken(): string {
  return randomBytes(32).toString("hex");
}

/** SHA-256 hash of a share token (hex output, 64 chars). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Encrypt share data with the master key directly (AES-256-GCM). */
export function encryptShareData(plaintext: string): ServerEncryptedData {
  const masterKey = getMasterKey();
  return encryptServerData(plaintext, masterKey);
}

/** Decrypt share data with the master key directly (AES-256-GCM). */
export function decryptShareData(encrypted: ServerEncryptedData): string {
  const masterKey = getMasterKey();
  return decryptServerData(encrypted, masterKey);
}
