/**
 * Client-side Recovery Key cryptography module using Web Crypto API.
 *
 * Recovery Key flow:
 *   recoveryKey (256-bit random)
 *     → HKDF (salt=random, info="passwd-sso-recovery-wrap-v1") → wrappingKey (AES-256-GCM)
 *       → wraps secretKey
 *     → HKDF (salt=empty, info="passwd-sso-recovery-verifier-v1") → verifierKey
 *       → SHA-256 → verifierHash
 *       → server stores HMAC(pepper, verifierHash)
 *
 * Recovery Key format: Base32 (RFC 4648), 4-char groups, 2-char checksum
 *   e.g. ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567-ABCD-EFGH-IJKL-MNOP-QR
 */

import { hexEncode, hexDecode } from "./crypto-client";

const HKDF_RECOVERY_WRAP_INFO = "passwd-sso-recovery-wrap-v1";
const HKDF_RECOVERY_VERIFIER_INFO = "passwd-sso-recovery-verifier-v1";
const RECOVERY_KEY_BYTES = 32;
const IV_LENGTH = 12;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";


// ─── Utility ────────────────────────────────────────────────────

function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
  return arr.buffer.slice(
    arr.byteOffset,
    arr.byteOffset + arr.byteLength,
  ) as ArrayBuffer;
}

function textEncode(text: string): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode(text));
}

// ─── Base32 Encode / Decode ─────────────────────────────────────

/** Base32 encode (RFC 4648, no padding). */
export function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let result = "";

  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    result += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return result;
}

/** Base32 decode (RFC 4648, no padding). */
export function base32Decode(encoded: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of encoded) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error("INVALID_CHARACTER");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(output);
}

// ─── Recovery Key Generation ────────────────────────────────────

/** Generate a 256-bit random recovery key. */
export function generateRecoveryKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(RECOVERY_KEY_BYTES));
}

/**
 * Format a recovery key as Base32 with checksum.
 * Output: 13 groups of 4 chars + 2-char checksum, separated by hyphens.
 * Total: 52 Base32 chars (32 bytes) + 2 checksum chars = 54 chars.
 */
export async function formatRecoveryKey(key: Uint8Array): Promise<string> {
  const encoded = base32Encode(key); // 52 chars for 32 bytes

  // Checksum: SHA-256(key) → first 10 bits → 2 Base32 chars
  const hash = await crypto.subtle.digest("SHA-256", toArrayBuffer(key));
  const hashBytes = new Uint8Array(hash);
  const checksumValue = ((hashBytes[0] << 2) | (hashBytes[1] >>> 6)) & 0x3ff;
  const cs0 = BASE32_ALPHABET[(checksumValue >>> 5) & 0x1f];
  const cs1 = BASE32_ALPHABET[checksumValue & 0x1f];

  const withChecksum = encoded + cs0 + cs1; // 54 chars

  // Split into 4-char groups with hyphens
  const groups: string[] = [];
  for (let i = 0; i < withChecksum.length; i += 4) {
    groups.push(withChecksum.slice(i, i + 4));
  }
  // Last group is 2 chars (checksum)
  return groups.join("-");
}

/**
 * Parse a formatted recovery key string.
 * Normalizes: removes hyphens/spaces, uppercases.
 * Validates checksum. Returns 32-byte key or throws.
 */
export async function parseRecoveryKey(formatted: string): Promise<Uint8Array> {
  // Normalize: remove hyphens and spaces, uppercase
  const clean = formatted.replace(/[-\s]/g, "").toUpperCase();

  if (clean.length !== 54) {
    throw new Error("INVALID_LENGTH");
  }

  // Validate all chars are in Base32 alphabet
  for (const char of clean) {
    if (!BASE32_ALPHABET.includes(char)) {
      throw new Error("INVALID_CHARACTER");
    }
  }

  // Split: 52 data chars + 2 checksum chars
  const dataChars = clean.slice(0, 52);
  const checksumChars = clean.slice(52);

  // Decode data
  const key = base32Decode(dataChars);
  if (key.length !== RECOVERY_KEY_BYTES) {
    throw new Error("INVALID_LENGTH");
  }

  // Verify checksum
  const hash = await crypto.subtle.digest("SHA-256", toArrayBuffer(key));
  const hashBytes = new Uint8Array(hash);
  const expectedValue = ((hashBytes[0] << 2) | (hashBytes[1] >>> 6)) & 0x3ff;
  const expectedCs0 = BASE32_ALPHABET[(expectedValue >>> 5) & 0x1f];
  const expectedCs1 = BASE32_ALPHABET[expectedValue & 0x1f];

  if (checksumChars !== expectedCs0 + expectedCs1) {
    throw new Error("INVALID_CHECKSUM");
  }

  return key;
}

// ─── Key Derivation ─────────────────────────────────────────────

/**
 * Derive the recovery wrapping key from a recovery key + salt via HKDF.
 * No PBKDF2 needed — recovery key has 256-bit entropy.
 */
export async function deriveRecoveryWrappingKey(
  recoveryKey: Uint8Array,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(recoveryKey),
    "HKDF",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      info: textEncode(HKDF_RECOVERY_WRAP_INFO),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// ─── Wrap / Unwrap SecretKey ────────────────────────────────────

export interface RecoveryWrappedData {
  encryptedSecretKey: string; // hex
  iv: string; // hex
  authTag: string; // hex
  hkdfSalt: string; // hex (32 bytes)
  verifierHash: string; // hex (SHA-256 of HKDF-derived verifier key)
}

/**
 * Wrap the secretKey with a recovery key.
 * Returns encrypted data + verifier hash for server storage.
 */
export async function wrapSecretKeyWithRecovery(
  secretKey: Uint8Array,
  recoveryKey: Uint8Array,
): Promise<RecoveryWrappedData> {
  // 1. Random salt for wrapping key derivation
  const salt = crypto.getRandomValues(new Uint8Array(32));

  // 2. Derive wrapping key
  const wrappingKey = await deriveRecoveryWrappingKey(recoveryKey, salt);

  // 3. AES-256-GCM encrypt secretKey
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    wrappingKey,
    toArrayBuffer(secretKey),
  );

  const encryptedBytes = new Uint8Array(encrypted);
  const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - 16);
  const authTag = encryptedBytes.slice(encryptedBytes.length - 16);

  // 4. Compute verifier hash
  const verifierHash = await computeRecoveryVerifierHash(recoveryKey);

  return {
    encryptedSecretKey: hexEncode(ciphertext),
    iv: hexEncode(iv),
    authTag: hexEncode(authTag),
    hkdfSalt: hexEncode(salt),
    verifierHash,
  };
}

/**
 * Unwrap the secretKey using a recovery key.
 */
export async function unwrapSecretKeyWithRecovery(
  encrypted: { encryptedSecretKey: string; iv: string; authTag: string },
  recoveryKey: Uint8Array,
  hkdfSalt: string,
): Promise<Uint8Array> {
  const salt = hexDecode(hkdfSalt);
  const wrappingKey = await deriveRecoveryWrappingKey(recoveryKey, salt);

  const ciphertext = hexDecode(encrypted.encryptedSecretKey);
  const iv = hexDecode(encrypted.iv);
  const authTag = hexDecode(encrypted.authTag);

  // Reconstruct combined buffer (ciphertext + authTag) for Web Crypto
  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext);
  combined.set(authTag, ciphertext.length);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    wrappingKey,
    toArrayBuffer(combined),
  );

  return new Uint8Array(decrypted);
}

// ─── Verifier Hash ──────────────────────────────────────────────

/**
 * Compute the recovery key verifier hash.
 * HKDF(recoveryKey, empty salt, VERIFIER_INFO) → verifierKey → SHA-256 → hex
 */
export async function computeRecoveryVerifierHash(
  recoveryKey: Uint8Array,
): Promise<string> {
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(recoveryKey),
    "HKDF",
    false,
    ["deriveBits"],
  );

  const verifierKeyBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new ArrayBuffer(32), // empty salt
      info: textEncode(HKDF_RECOVERY_VERIFIER_INFO),
    },
    hkdfKey,
    256,
  );

  const hash = await crypto.subtle.digest("SHA-256", verifierKeyBits);
  return hexEncode(new Uint8Array(hash));
}
