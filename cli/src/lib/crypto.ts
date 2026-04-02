/**
 * Crypto module for the CLI tool using Node.js crypto.subtle (Web Crypto API compatible).
 *
 * Ported from src/lib/crypto-client.ts — identical key derivation and encryption
 * to ensure interoperability with the Web UI.
 */

const PBKDF2_ITERATIONS = 600_000;
const AES_KEY_LENGTH = 256;
const IV_LENGTH = 12;
const HKDF_ENC_INFO = "passwd-sso-enc-v1";
const HKDF_AUTH_INFO = "passwd-sso-auth-v1";
const VERIFICATION_PLAINTEXT = "passwd-sso-vault-verification-v1";

const VERIFIER_DOMAIN_PREFIX = "verifier";
const VERIFIER_PBKDF2_HASH = "SHA-256";
const VERIFIER_PBKDF2_ITERATIONS = 600_000;
const VERIFIER_PBKDF2_BITS = 256;

export interface EncryptedData {
  ciphertext: string; // hex
  iv: string; // hex
  authTag: string; // hex
}

// ─── Utility ──────────────────────────────────────────────────

export function hexEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexDecode(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("Invalid hex string: odd length");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
  return (arr.buffer as ArrayBuffer).slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
}

function textEncode(text: string): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode(text));
}

function textDecode(buf: ArrayBuffer): string {
  return new TextDecoder().decode(buf);
}

// ─── Key Derivation ────────────────────────────────────────────

export async function deriveWrappingKey(
  passphrase: string,
  accountSalt: Uint8Array,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    textEncode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
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
    false,
    ["encrypt", "decrypt"],
  );
}

export async function deriveEncryptionKey(
  secretKey: Uint8Array,
): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secretKey),
    "HKDF",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      // Risk-accepted: zero salt. The IKM (secretKey) is a 256-bit random value
      // wrapped by PBKDF2(600k iterations), providing full entropy. RFC 5869 §3.1
      // notes that a zero salt defaults to HashLen zeros and is acceptable when
      // the IKM is already uniformly random. Domain separation relies on the
      // distinct `info` parameter (HKDF_ENC_INFO vs HKDF_AUTH_INFO).
      salt: new ArrayBuffer(32),
      info: textEncode(HKDF_ENC_INFO),
    },
    hkdfKey,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function deriveAuthKey(
  secretKey: Uint8Array,
): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secretKey),
    "HKDF",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      // See deriveEncryptionKey for zero-salt risk acceptance rationale
      salt: new ArrayBuffer(32),
      info: textEncode(HKDF_AUTH_INFO),
    },
    hkdfKey,
    { name: "HMAC", hash: "SHA-256", length: AES_KEY_LENGTH },
    true,
    ["sign"],
  );
}

// ─── Secret Key Management ─────────────────────────────────────

export async function unwrapSecretKey(
  encrypted: EncryptedData,
  wrappingKey: CryptoKey,
): Promise<Uint8Array> {
  const ciphertext = hexDecode(encrypted.ciphertext);
  const iv = hexDecode(encrypted.iv);
  const authTag = hexDecode(encrypted.authTag);

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

// ─── Auth Hash ────────────────────────────────────────────────

export async function computeAuthHash(authKey: CryptoKey): Promise<string> {
  const rawKey = await crypto.subtle.exportKey("raw", authKey);
  const hash = await crypto.subtle.digest("SHA-256", rawKey);
  return hexEncode(hash);
}

// ─── Verification ──────────────────────────────────────────────

export async function verifyKey(
  encryptionKey: CryptoKey,
  artifact: EncryptedData,
): Promise<boolean> {
  try {
    const plaintext = await decryptData(artifact, encryptionKey);
    return plaintext === VERIFICATION_PLAINTEXT;
  } catch {
    return false;
  }
}

// ─── E2E Encryption ────────────────────────────────────────────

export async function encryptData(
  plaintext: string,
  key: CryptoKey,
  aad?: Uint8Array,
): Promise<EncryptedData> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const params: AesGcmParams = { name: "AES-GCM", iv: toArrayBuffer(iv) };
  if (aad) params.additionalData = toArrayBuffer(aad);

  const encrypted = await crypto.subtle.encrypt(params, key, textEncode(plaintext));

  const encryptedBytes = new Uint8Array(encrypted);
  const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - 16);
  const authTag = encryptedBytes.slice(encryptedBytes.length - 16);

  return {
    ciphertext: hexEncode(ciphertext),
    iv: hexEncode(iv),
    authTag: hexEncode(authTag),
  };
}

export async function decryptData(
  encrypted: EncryptedData,
  key: CryptoKey,
  aad?: Uint8Array,
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
    toArrayBuffer(combined),
  );
  return textDecode(decrypted);
}

// ─── Passphrase Verifier ──────────────────────────────────────

export async function deriveVerifierSalt(
  accountSalt: Uint8Array,
): Promise<Uint8Array> {
  const prefix = new TextEncoder().encode(VERIFIER_DOMAIN_PREFIX);
  const combined = new Uint8Array(prefix.length + accountSalt.length);
  combined.set(prefix);
  combined.set(accountSalt, prefix.length);
  const hash = await crypto.subtle.digest("SHA-256", toArrayBuffer(combined));
  return new Uint8Array(hash);
}

export async function computePassphraseVerifier(
  passphrase: string,
  accountSalt: Uint8Array,
): Promise<string> {
  const verifierSalt = await deriveVerifierSalt(accountSalt);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    textEncode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const verifierKeyBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(verifierSalt),
      iterations: VERIFIER_PBKDF2_ITERATIONS,
      hash: VERIFIER_PBKDF2_HASH,
    },
    keyMaterial,
    VERIFIER_PBKDF2_BITS,
  );

  const verifierHash = await crypto.subtle.digest("SHA-256", verifierKeyBits);
  return hexEncode(verifierHash);
}
