/**
 * Client-side encryption/decryption for password-protected exports.
 *
 * Uses AES-256-GCM with PBKDF2-HMAC-SHA256 key derivation (600k iterations).
 * Independent from the vault encryption — uses its own salt per export.
 */

import { hexEncode, hexDecode } from "@/lib/crypto-client";

const PBKDF2_ITERATIONS = 600_000;
const AES_KEY_LENGTH = 256;
const SALT_LENGTH = 16; // 128 bits
const IV_LENGTH = 12; // 96 bits, recommended for GCM

export interface EncryptedExportFile {
  version: 1;
  format: "csv" | "json";
  createdAt: string;
  cipher: "AES-256-GCM";
  kdf: {
    name: "PBKDF2-HMAC-SHA256";
    iterations: number;
    salt: string; // hex
  };
  iv: string; // hex
  authTag: string; // hex
  ciphertext: string; // hex
}

/**
 * Derive an AES-256-GCM key from a password and salt using PBKDF2.
 */
async function deriveExportKey(
  password: string,
  salt: Uint8Array
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt.buffer.slice(
        salt.byteOffset,
        salt.byteOffset + salt.byteLength
      ) as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypt export data with a password.
 * Returns a JSON-serializable object containing all encryption parameters.
 */
export async function encryptExport(
  plaintext: string,
  password: string,
  format: "csv" | "json"
): Promise<EncryptedExportFile> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveExportKey(password, salt);

  const encoder = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv.buffer.slice(
        iv.byteOffset,
        iv.byteOffset + iv.byteLength
      ) as ArrayBuffer,
    },
    key,
    encoder.encode(plaintext)
  );

  // Web Crypto API appends the 16-byte auth tag to the ciphertext
  const encryptedBytes = new Uint8Array(encrypted);
  const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - 16);
  const authTag = encryptedBytes.slice(encryptedBytes.length - 16);

  return {
    version: 1,
    format,
    createdAt: new Date().toISOString(),
    cipher: "AES-256-GCM",
    kdf: {
      name: "PBKDF2-HMAC-SHA256",
      iterations: PBKDF2_ITERATIONS,
      salt: hexEncode(salt),
    },
    iv: hexEncode(iv),
    authTag: hexEncode(authTag),
    ciphertext: hexEncode(ciphertext),
  };
}

/**
 * Decrypt a password-protected export file.
 * Returns the plaintext content and original format.
 * Throws on wrong password or corrupted data.
 */
export async function decryptExport(
  file: EncryptedExportFile,
  password: string
): Promise<{ plaintext: string; format: "csv" | "json" }> {
  const salt = hexDecode(file.kdf.salt);
  const iv = hexDecode(file.iv);
  const authTag = hexDecode(file.authTag);
  const ciphertext = hexDecode(file.ciphertext);

  const key = await deriveExportKey(password, salt);

  // Reconstruct combined buffer (ciphertext + authTag) for Web Crypto
  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext);
  combined.set(authTag, ciphertext.length);

  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: iv.buffer.slice(
        iv.byteOffset,
        iv.byteOffset + iv.byteLength
      ) as ArrayBuffer,
    },
    key,
    combined.buffer.slice(
      combined.byteOffset,
      combined.byteOffset + combined.byteLength
    ) as ArrayBuffer
  );

  const decoder = new TextDecoder();
  return {
    plaintext: decoder.decode(decrypted),
    format: file.format,
  };
}

/**
 * Check if a parsed JSON object is an encrypted export file.
 */
export function isEncryptedExport(data: unknown): data is EncryptedExportFile {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    obj.version === 1 &&
    obj.cipher === "AES-256-GCM" &&
    typeof obj.ciphertext === "string" &&
    typeof obj.iv === "string" &&
    typeof obj.authTag === "string" &&
    typeof obj.kdf === "object" &&
    obj.kdf !== null
  );
}
