/**
 * Client-side cryptography module using Web Crypto API.
 *
 * Key hierarchy:
 *   passphrase → PBKDF2 → wrappingKey → wraps/unwraps secretKey
 *   secretKey  → HKDF   → encryptionKey (AES-256-GCM for vault data)
 *   secretKey  → HKDF   → authKey       (SHA-256 hash sent to server for verification)
 *
 * All CryptoKey objects are created with extractable: false.
 */

const PBKDF2_ITERATIONS = 600_000;
const AES_KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96 bits, recommended for GCM
const HKDF_ENC_INFO = "passwd-sso-enc-v1";
const HKDF_AUTH_INFO = "passwd-sso-auth-v1";
const VERIFICATION_PLAINTEXT = "passwd-sso-vault-verification-v1";

export interface EncryptedData {
  ciphertext: string; // hex
  iv: string; // hex
  authTag: string; // hex
}

export interface EncryptedBinary {
  ciphertext: Uint8Array;
  iv: string; // hex
  authTag: string; // hex
}

// ─── Utility ────────────────────────────────────────────────────

export function hexEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexDecode(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/** Convert Uint8Array to ArrayBuffer (fixes TS BufferSource compatibility) */
function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
  return arr.buffer.slice(
    arr.byteOffset,
    arr.byteOffset + arr.byteLength
  ) as ArrayBuffer;
}

function textEncode(text: string): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode(text));
}

function textDecode(buf: ArrayBuffer): string {
  return new TextDecoder().decode(buf);
}

// ─── Key Derivation ─────────────────────────────────────────────

/**
 * Derive a wrapping key from the user's passphrase + account salt.
 * Uses PBKDF2 with 600,000 iterations of SHA-256.
 */
export async function deriveWrappingKey(
  passphrase: string,
  accountSalt: Uint8Array
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    textEncode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(accountSalt),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false, // non-extractable
    ["encrypt", "decrypt"]
  );
}

/**
 * Derive the vault encryption key from the secret key via HKDF.
 */
export async function deriveEncryptionKey(
  secretKey: Uint8Array
): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secretKey),
    "HKDF",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new ArrayBuffer(32), // empty salt (secret key has sufficient entropy)
      info: textEncode(HKDF_ENC_INFO),
    },
    hkdfKey,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Derive the auth key from the secret key via HKDF.
 * Domain-separated from the encryption key — cannot be used to derive it.
 */
export async function deriveAuthKey(
  secretKey: Uint8Array
): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secretKey),
    "HKDF",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new ArrayBuffer(32),
      info: textEncode(HKDF_AUTH_INFO),
    },
    hkdfKey,
    { name: "HMAC", hash: "SHA-256", length: AES_KEY_LENGTH },
    true, // extractable — we need to hash it
    ["sign"]
  );
}

// ─── Secret Key Management ──────────────────────────────────────

/**
 * Generate a cryptographically random 256-bit secret key.
 */
export function generateSecretKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Generate a random account salt (256-bit).
 */
export function generateAccountSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Encrypt the secret key with the wrapping key (AES-256-GCM).
 */
export async function wrapSecretKey(
  secretKey: Uint8Array,
  wrappingKey: CryptoKey
): Promise<EncryptedData> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    wrappingKey,
    toArrayBuffer(secretKey)
  );

  // Web Crypto API appends the auth tag to the ciphertext
  const encryptedBytes = new Uint8Array(encrypted);
  const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - 16);
  const authTag = encryptedBytes.slice(encryptedBytes.length - 16);

  return {
    ciphertext: hexEncode(ciphertext),
    iv: hexEncode(iv),
    authTag: hexEncode(authTag),
  };
}

/**
 * Decrypt the secret key with the wrapping key.
 */
export async function unwrapSecretKey(
  encrypted: EncryptedData,
  wrappingKey: CryptoKey
): Promise<Uint8Array> {
  const ciphertext = hexDecode(encrypted.ciphertext);
  const iv = hexDecode(encrypted.iv);
  const authTag = hexDecode(encrypted.authTag);

  // Reconstruct combined buffer (ciphertext + authTag) for Web Crypto
  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext);
  combined.set(authTag, ciphertext.length);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    wrappingKey,
    toArrayBuffer(combined)
  );

  return new Uint8Array(decrypted);
}

// ─── Auth Hash ──────────────────────────────────────────────────

/**
 * Compute an auth hash from the auth key for server verification.
 * The server never sees the secret key or encryption key.
 */
export async function computeAuthHash(authKey: CryptoKey): Promise<string> {
  const rawKey = await crypto.subtle.exportKey("raw", authKey);
  const hash = await crypto.subtle.digest("SHA-256", rawKey);
  return hexEncode(hash);
}

// ─── Verification Artifact ──────────────────────────────────────

/**
 * Create a verification artifact: encrypt a known plaintext with the encryption key.
 * Used to verify that the user entered the correct passphrase.
 */
export async function createVerificationArtifact(
  encryptionKey: CryptoKey
): Promise<EncryptedData> {
  return encryptData(VERIFICATION_PLAINTEXT, encryptionKey);
}

/**
 * Verify the encryption key by attempting to decrypt the verification artifact.
 */
export async function verifyKey(
  encryptionKey: CryptoKey,
  artifact: EncryptedData
): Promise<boolean> {
  try {
    const plaintext = await decryptData(artifact, encryptionKey);
    return plaintext === VERIFICATION_PLAINTEXT;
  } catch {
    return false;
  }
}

// ─── E2E Encryption ─────────────────────────────────────────────

/**
 * Encrypt plaintext with AES-256-GCM. Optional AAD for binding context.
 */
export async function encryptData(
  plaintext: string,
  key: CryptoKey,
  aad?: Uint8Array
): Promise<EncryptedData> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const params: AesGcmParams = { name: "AES-GCM", iv: toArrayBuffer(iv) };
  if (aad) params.additionalData = toArrayBuffer(aad);

  const encrypted = await crypto.subtle.encrypt(
    params,
    key,
    textEncode(plaintext)
  );

  const encryptedBytes = new Uint8Array(encrypted);
  const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - 16);
  const authTag = encryptedBytes.slice(encryptedBytes.length - 16);

  return {
    ciphertext: hexEncode(ciphertext),
    iv: hexEncode(iv),
    authTag: hexEncode(authTag),
  };
}

/**
 * Decrypt ciphertext with AES-256-GCM. Optional AAD must match encryption.
 */
export async function decryptData(
  encrypted: EncryptedData,
  key: CryptoKey,
  aad?: Uint8Array
): Promise<string> {
  const ciphertext = hexDecode(encrypted.ciphertext);
  const iv = hexDecode(encrypted.iv);
  const authTag = hexDecode(encrypted.authTag);

  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext);
  combined.set(authTag, ciphertext.length);

  const params: AesGcmParams = { name: "AES-GCM", iv: toArrayBuffer(iv) };
  if (aad) params.additionalData = toArrayBuffer(aad);

  const decrypted = await crypto.subtle.decrypt(
    params,
    key,
    toArrayBuffer(combined)
  );
  return textDecode(decrypted);
}

// ─── Binary E2E Encryption (for file attachments) ───────────────

/**
 * Encrypt binary data (ArrayBuffer) with AES-256-GCM. Optional AAD for binding context.
 * Returns raw Uint8Array ciphertext instead of hex — more efficient for large files.
 */
export async function encryptBinary(
  data: ArrayBuffer,
  key: CryptoKey,
  aad?: Uint8Array
): Promise<EncryptedBinary> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const params: AesGcmParams = { name: "AES-GCM", iv: toArrayBuffer(iv) };
  if (aad) params.additionalData = toArrayBuffer(aad);

  const encrypted = await crypto.subtle.encrypt(params, key, data);

  const encryptedBytes = new Uint8Array(encrypted);
  const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - 16);
  const authTag = encryptedBytes.slice(encryptedBytes.length - 16);

  return {
    ciphertext,
    iv: hexEncode(iv),
    authTag: hexEncode(authTag),
  };
}

/**
 * Decrypt binary data (EncryptedBinary) with AES-256-GCM. Optional AAD must match encryption.
 * Accepts raw Uint8Array ciphertext — reverse of encryptBinary.
 */
export async function decryptBinary(
  encrypted: EncryptedBinary,
  key: CryptoKey,
  aad?: Uint8Array
): Promise<ArrayBuffer> {
  const iv = hexDecode(encrypted.iv);
  const authTag = hexDecode(encrypted.authTag);

  const combined = new Uint8Array(encrypted.ciphertext.length + authTag.length);
  combined.set(encrypted.ciphertext);
  combined.set(authTag, encrypted.ciphertext.length);

  const params: AesGcmParams = { name: "AES-GCM", iv: toArrayBuffer(iv) };
  if (aad) params.additionalData = toArrayBuffer(aad);

  return crypto.subtle.decrypt(params, key, toArrayBuffer(combined));
}
