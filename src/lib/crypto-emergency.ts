/**
 * ECDH key exchange for Emergency Access (wrapVersion=2).
 *
 * Flow:
 *   1. Grantee generates ECDH key pair (P-256)
 *   2. Grantee's private key is encrypted with their vault encryptionKey
 *   3. Owner generates ephemeral ECDH key pair
 *   4. ECDH(ownerEphemeral, granteePublic) → shared secret → HKDF(random salt) → wrapping key
 *   5. Wrapping key encrypts owner's secretKey for grantee (with AAD context binding)
 *   6. Grantee reverses: ECDH(granteePrivate, ownerEphemeralPublic) → same wrapping key
 *
 * Security (v2):
 *   - HKDF uses random 32-byte salt (stored in DB) — prevents same-key reuse across grants
 *   - AES-GCM AAD binds ciphertext to grant context (grantId|ownerId|granteeId|keyVersion|wrapVersion)
 *     using fixed-order pipe-separated concatenation to avoid JSON serialization ordering issues
 *   - HKDF info includes version string for future algorithm migration
 *   - wrapVersion field enables v2→v3 migration without breaking existing data
 *
 * Uses Web Crypto API. All CryptoKey objects are non-extractable except where export is needed.
 */

import {
  encryptData,
  decryptData,
  hexEncode,
  hexDecode,
  type EncryptedData,
} from "./crypto-client";

const ECDH_CURVE = "P-256";
const HKDF_EMERGENCY_INFO = "passwd-sso-emergency-v1";
const AES_KEY_LENGTH = 256;
const IV_LENGTH = 12;
const HKDF_SALT_LENGTH = 32;
const CURRENT_WRAP_VERSION = 1;

// ─── Types ──────────────────────────────────────────────────

/**
 * Context for AAD binding. All fields are included in the AES-GCM AAD
 * to prevent ciphertext transplant attacks between grants.
 */
export interface WrapContext {
  grantId: string;
  ownerId: string;
  granteeId: string;
  keyVersion: number;
  wrapVersion: number;
}

// ─── Utility ────────────────────────────────────────────────

function textEncode(text: string): ArrayBuffer {
  const arr = new TextEncoder().encode(text);
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
}

function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
}

/**
 * Build AAD bytes from WrapContext.
 * Fixed-order pipe-separated concatenation (not JSON) to guarantee byte-identical
 * AAD between encrypt and decrypt.
 */
export function buildAAD(ctx: WrapContext): ArrayBuffer {
  const aad = [
    ctx.grantId,
    ctx.ownerId,
    ctx.granteeId,
    String(ctx.keyVersion),
    String(ctx.wrapVersion),
  ].join("|");
  return textEncode(aad);
}

// ─── Key Pair Generation ────────────────────────────────────

/**
 * Generate an ECDH key pair (P-256).
 * extractable: true so we can export public key as JWK and private key as PKCS8.
 */
export async function generateECDHKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: ECDH_CURVE },
    true,
    ["deriveKey", "deriveBits"]
  );
}

// ─── Key Export / Import ────────────────────────────────────

/** Export public key as JWK JSON string (for DB storage). */
export async function exportPublicKey(publicKey: CryptoKey): Promise<string> {
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  return JSON.stringify(jwk);
}

/** Export private key as PKCS8 bytes (for encryption before storage). */
export async function exportPrivateKey(privateKey: CryptoKey): Promise<Uint8Array> {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", privateKey);
  return new Uint8Array(pkcs8);
}

/** Import public key from JWK JSON string. */
export async function importPublicKey(jwkString: string): Promise<CryptoKey> {
  const jwk = JSON.parse(jwkString);
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: ECDH_CURVE },
    false,
    []
  );
}

/** Import private key from PKCS8 bytes. */
export async function importPrivateKey(pkcs8Bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(pkcs8Bytes),
    { name: "ECDH", namedCurve: ECDH_CURVE },
    false,
    ["deriveKey", "deriveBits"]
  );
}

// ─── Shared Key Derivation ──────────────────────────────────

/**
 * Derive a shared AES-256-GCM key from ECDH.
 * ECDH → raw bits → HKDF(salt, "passwd-sso-emergency-v1") → AES-256-GCM key.
 *
 * @param salt - 32-byte random salt (generated per grant, stored in DB)
 */
export async function deriveSharedKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  salt: Uint8Array
): Promise<CryptoKey> {
  // Step 1: ECDH → shared bits
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    256
  );

  // Step 2: Import as HKDF key material
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    sharedBits,
    "HKDF",
    false,
    ["deriveKey"]
  );

  // Step 3: HKDF → AES-256-GCM key (with random salt)
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      info: textEncode(HKDF_EMERGENCY_INFO),
    },
    hkdfKey,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  );
}

// ─── Private Key Encryption (grantee stores in DB) ──────────

/**
 * Encrypt grantee's ECDH private key with their vault encryptionKey.
 * Stored in EmergencyAccessKeyPair table.
 */
export async function encryptPrivateKey(
  privateKeyBytes: Uint8Array,
  encryptionKey: CryptoKey
): Promise<EncryptedData> {
  // Encode as hex string, then encrypt as text
  const hex = hexEncode(privateKeyBytes);
  return encryptData(hex, encryptionKey);
}

/**
 * Decrypt grantee's ECDH private key.
 */
export async function decryptPrivateKey(
  encrypted: EncryptedData,
  encryptionKey: CryptoKey
): Promise<Uint8Array> {
  const hex = await decryptData(encrypted, encryptionKey);
  return hexDecode(hex);
}

// ─── Secret Key Wrapping (owner → grantee) ──────────────────

/**
 * Owner wraps their secretKey for grantee using ECDH.
 * Uses random HKDF salt and structured AAD for context binding.
 */
export async function wrapSecretKeyForGrantee(
  ownerSecretKey: Uint8Array,
  ownerEphemeralPrivateKey: CryptoKey,
  granteePublicKey: CryptoKey,
  salt: Uint8Array,
  ctx: WrapContext
): Promise<{ encrypted: EncryptedData }> {
  // Derive shared AES key with salt
  const sharedKey = await deriveSharedKey(ownerEphemeralPrivateKey, granteePublicKey, salt);

  // Encrypt owner's secretKey with AAD context binding
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const aesParams: AesGcmParams = {
    name: "AES-GCM",
    iv: toArrayBuffer(iv),
    additionalData: buildAAD(ctx),
  };
  const encryptedBuf = await crypto.subtle.encrypt(
    aesParams,
    sharedKey,
    toArrayBuffer(ownerSecretKey)
  );

  const encryptedBytes = new Uint8Array(encryptedBuf);
  const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - 16);
  const authTag = encryptedBytes.slice(encryptedBytes.length - 16);

  return {
    encrypted: {
      ciphertext: hexEncode(ciphertext),
      iv: hexEncode(iv),
      authTag: hexEncode(authTag),
    },
  };
}

/**
 * Grantee unwraps owner's secretKey using ECDH.
 * Must provide the same salt and WrapContext used during wrapping.
 */
export async function unwrapSecretKeyAsGrantee(
  encrypted: EncryptedData,
  ownerEphemeralPublicKeyJwk: string,
  granteePrivateKey: CryptoKey,
  salt: Uint8Array,
  ctx: WrapContext
): Promise<Uint8Array> {
  // Import owner's ephemeral public key
  const ownerPubKey = await importPublicKey(ownerEphemeralPublicKeyJwk);

  // Derive same shared AES key with salt
  const sharedKey = await deriveSharedKey(granteePrivateKey, ownerPubKey, salt);

  // Decrypt with AAD
  const ciphertext = hexDecode(encrypted.ciphertext);
  const iv = hexDecode(encrypted.iv);
  const authTag = hexDecode(encrypted.authTag);

  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext);
  combined.set(authTag, ciphertext.length);

  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: buildAAD(ctx),
    },
    sharedKey,
    toArrayBuffer(combined)
  );

  return new Uint8Array(decrypted);
}

/**
 * Full wrap flow: generate ephemeral key pair, generate HKDF salt,
 * wrap secretKey with structured AAD, return all data for DB storage.
 */
export async function createKeyEscrow(
  ownerSecretKey: Uint8Array,
  granteePublicKeyJwk: string,
  ctx: Omit<WrapContext, "wrapVersion" | "keyVersion">
): Promise<{
  ownerEphemeralPublicKey: string;
  encryptedSecretKey: string;
  secretKeyIv: string;
  secretKeyAuthTag: string;
  hkdfSalt: string;
  wrapVersion: number;
}> {
  const ephemeralKeyPair = await generateECDHKeyPair();
  const granteePublicKey = await importPublicKey(granteePublicKeyJwk);

  // Generate random HKDF salt
  const salt = crypto.getRandomValues(new Uint8Array(HKDF_SALT_LENGTH));

  const wrapCtx: WrapContext = {
    ...ctx,
    keyVersion: 1,
    wrapVersion: CURRENT_WRAP_VERSION,
  };

  const { encrypted } = await wrapSecretKeyForGrantee(
    ownerSecretKey,
    ephemeralKeyPair.privateKey,
    granteePublicKey,
    salt,
    wrapCtx
  );

  const ownerEphemeralPublicKey = await exportPublicKey(ephemeralKeyPair.publicKey);

  return {
    ownerEphemeralPublicKey,
    encryptedSecretKey: encrypted.ciphertext,
    secretKeyIv: encrypted.iv,
    secretKeyAuthTag: encrypted.authTag,
    hkdfSalt: hexEncode(salt),
    wrapVersion: CURRENT_WRAP_VERSION,
  };
}
