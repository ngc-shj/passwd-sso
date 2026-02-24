/**
 * Org E2E Encryption (ECDH-P256)
 *
 * Provides client-side encryption for organization vault entries using
 * ECDH key exchange for per-member org key distribution.
 *
 * Key derivation chain:
 *   ECDH(ephemeral, member) → HKDF("passwd-sso-org-v1", random salt) → AES-256-GCM wrapping key
 *   orgKey → HKDF("passwd-sso-org-enc-v1", empty) → AES-256-GCM encryption key
 *
 * Reuses patterns from crypto-emergency.ts (ECDH) and crypto-client.ts (AES-GCM).
 */

import {
  type EncryptedData,
  hexEncode,
  hexDecode,
  encryptData,
  decryptData,
  encryptBinary,
  decryptBinary,
  type EncryptedBinary,
} from "./crypto-client";
import {
  generateECDHKeyPair,
  exportPublicKey,
  importPublicKey,
} from "./crypto-emergency";

// ─── Constants ──────────────────────────────────────────────────

const AES_KEY_LENGTH = 256;
const IV_LENGTH = 12;
const HKDF_SALT_LENGTH = 32;

/** HKDF info for org key wrapping (ECDH → AES key) */
const HKDF_ORG_WRAP_INFO = "passwd-sso-org-v1";

/** HKDF info for org entry encryption (orgKey → AES key) */
const HKDF_ORG_ENC_INFO = "passwd-sso-org-enc-v1";

/** HKDF info for ECDH private key wrapping (secretKey → ecdhWrappingKey) */
export const HKDF_ECDH_WRAP_INFO = "passwd-sso-ecdh-v1";

export const CURRENT_ORG_WRAP_VERSION = 1;

/** AAD scope for OrgMemberKey wrapping */
const AAD_SCOPE_ORG_KEY = "OK";

/** AAD version for org key wrapping */
const AAD_VERSION = 1;

// ─── Utility ────────────────────────────────────────────────────

function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
  return arr.buffer.slice(
    arr.byteOffset,
    arr.byteOffset + arr.byteLength
  ) as ArrayBuffer;
}

function textEncode(text: string): ArrayBuffer {
  const arr = new TextEncoder().encode(text);
  return arr.buffer.slice(
    arr.byteOffset,
    arr.byteOffset + arr.byteLength
  ) as ArrayBuffer;
}

// ─── Org Symmetric Key Generation ───────────────────────────────

/** Generate a random 256-bit org symmetric key */
export function generateOrgSymmetricKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

// ─── Org Encryption Key Derivation ──────────────────────────────

/**
 * Derive AES-256-GCM encryption key from org symmetric key.
 * HKDF(orgKey, info="passwd-sso-org-enc-v1", salt=empty)
 *
 * Salt is empty because orgKey itself is unique per org (256-bit random).
 */
export async function deriveOrgEncryptionKey(
  orgKey: Uint8Array
): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(orgKey),
    "HKDF",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new ArrayBuffer(32), // empty salt — orgKey has sufficient entropy
      info: textEncode(HKDF_ORG_ENC_INFO),
    },
    hkdfKey,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  );
}

// ─── ECDH Wrapping Key Derivation ───────────────────────────────

/**
 * Derive AES-256-GCM wrapping key from ECDH shared secret.
 * HKDF(sharedBits, info="passwd-sso-org-v1", salt=random per-escrow salt)
 *
 * The random salt is generated per key-wrapping operation and stored in OrgMemberKey.
 * Org-level domain separation is enforced via AAD (which includes orgId).
 */
async function deriveOrgWrappingKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  salt: Uint8Array
): Promise<CryptoKey> {
  // ECDH → shared bits (256 bits)
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    256
  );

  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    sharedBits,
    "HKDF",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      info: textEncode(HKDF_ORG_WRAP_INFO),
    },
    hkdfKey,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  );
}

// ─── ECDH Private Key Wrapping (for vault storage) ──────────────

/**
 * Derive ecdhWrappingKey from secretKey (domain-separated from encryptionKey).
 * secretKey → HKDF("passwd-sso-ecdh-v1") → ecdhWrappingKey
 */
export async function deriveEcdhWrappingKey(
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
      info: textEncode(HKDF_ECDH_WRAP_INFO),
    },
    hkdfKey,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  );
}

// ─── AAD for OrgMemberKey Wrapping ──────────────────────────────

export interface OrgKeyWrapContext {
  orgId: string;
  toUserId: string;
  keyVersion: number;
  wrapVersion: number;
}

/**
 * Build AAD for OrgMemberKey wrapping.
 * Binary format (same as crypto-aad.ts buildAADBytes):
 *   [scope: 2B "OK"] [aadVersion: 1B] [nFields: 1B=4]
 *   [field_len: 2B BE] [field: N bytes] × 4
 *
 * Fields: orgId | toUserId | keyVersion | wrapVersion
 * Prevents cross-org, cross-user, and cross-version transplant attacks.
 */
export function buildOrgKeyWrapAAD(ctx: OrgKeyWrapContext): Uint8Array {
  const fields = [
    ctx.orgId,
    ctx.toUserId,
    String(ctx.keyVersion),
    String(ctx.wrapVersion),
  ];

  const encoder = new TextEncoder();
  const encodedFields = fields.map((f) => encoder.encode(f));

  const headerSize = 4; // scope(2) + aadVersion(1) + nFields(1)
  const fieldsSize = encodedFields.reduce((sum, ef) => sum + 2 + ef.length, 0);
  const totalSize = headerSize + fieldsSize;

  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  let offset = 0;

  // Scope: "OK"
  bytes[offset] = AAD_SCOPE_ORG_KEY.charCodeAt(0);
  bytes[offset + 1] = AAD_SCOPE_ORG_KEY.charCodeAt(1);
  offset += 2;

  // AAD version
  view.setUint8(offset, AAD_VERSION);
  offset += 1;

  // Number of fields
  view.setUint8(offset, fields.length);
  offset += 1;

  // Fields
  for (const encoded of encodedFields) {
    view.setUint16(offset, encoded.length, false); // big-endian
    offset += 2;
    bytes.set(encoded, offset);
    offset += encoded.length;
  }

  return bytes;
}

// ─── Org Key Wrapping (Admin → Member) ──────────────────────────

/**
 * Wrap org symmetric key for a member using ECDH.
 * Admin generates ephemeral key pair → ECDH with member's public key → AES-GCM wrap.
 */
export async function wrapOrgKeyForMember(
  orgKey: Uint8Array,
  ephemeralPrivateKey: CryptoKey,
  memberPublicKey: CryptoKey,
  hkdfSalt: Uint8Array,
  ctx: OrgKeyWrapContext
): Promise<EncryptedData> {
  const wrappingKey = await deriveOrgWrappingKey(
    ephemeralPrivateKey,
    memberPublicKey,
    hkdfSalt
  );

  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const aad = buildOrgKeyWrapAAD(ctx);

  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(aad),
    },
    wrappingKey,
    toArrayBuffer(orgKey)
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
 * Unwrap org symmetric key as a member.
 * Member uses their ECDH private key + admin's ephemeral public key → AES-GCM unwrap.
 *
 * @param hkdfSalt - Hex-encoded HKDF salt (stored in OrgMemberKey.hkdfSalt)
 */
export async function unwrapOrgKey(
  encrypted: EncryptedData,
  ephemeralPublicKeyJwk: string,
  memberPrivateKey: CryptoKey,
  hkdfSalt: string,
  ctx: OrgKeyWrapContext
): Promise<Uint8Array> {
  const ephemeralPublicKey = await importPublicKey(ephemeralPublicKeyJwk);
  const salt = hexDecode(hkdfSalt);

  const wrappingKey = await deriveOrgWrappingKey(
    memberPrivateKey,
    ephemeralPublicKey,
    salt
  );

  const ciphertext = hexDecode(encrypted.ciphertext);
  const iv = hexDecode(encrypted.iv);
  const authTag = hexDecode(encrypted.authTag);

  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext);
  combined.set(authTag, ciphertext.length);

  const aad = buildOrgKeyWrapAAD(ctx);

  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(aad),
    },
    wrappingKey,
    toArrayBuffer(combined)
  );

  return new Uint8Array(decrypted);
}

// ─── Key Escrow (One-shot wrap flow) ────────────────────────────

export interface OrgKeyEscrowResult {
  ephemeralPublicKey: string;
  encryptedOrgKey: string;
  orgKeyIv: string;
  orgKeyAuthTag: string;
  hkdfSalt: string;
  wrapVersion: number;
  keyVersion: number;
}

/**
 * Create org key escrow for a member.
 * Generates ephemeral ECDH key pair, wraps org key, returns all fields for storage.
 *
 * @param orgKey - Plaintext org symmetric key
 * @param memberPublicKeyJwk - Member's ECDH public key (JWK string)
 * @param orgId - Organization ID
 * @param toUserId - Member user ID
 * @param keyVersion - Org key version
 */
export async function createOrgKeyEscrow(
  orgKey: Uint8Array,
  memberPublicKeyJwk: string,
  orgId: string,
  toUserId: string,
  keyVersion: number
): Promise<OrgKeyEscrowResult> {
  const ephemeralKeyPair = await generateECDHKeyPair();
  const memberPublicKey = await importPublicKey(memberPublicKeyJwk);

  // Random HKDF salt — used in ECDH wrapping key derivation, stored in OrgMemberKey
  const salt = crypto.getRandomValues(new Uint8Array(HKDF_SALT_LENGTH));

  const ctx: OrgKeyWrapContext = {
    orgId,
    toUserId,
    keyVersion,
    wrapVersion: CURRENT_ORG_WRAP_VERSION,
  };

  const encrypted = await wrapOrgKeyForMember(
    orgKey,
    ephemeralKeyPair.privateKey,
    memberPublicKey,
    salt,
    ctx
  );

  const ephemeralPublicKeyJwk = await exportPublicKey(
    ephemeralKeyPair.publicKey
  );

  return {
    ephemeralPublicKey: ephemeralPublicKeyJwk,
    encryptedOrgKey: encrypted.ciphertext,
    orgKeyIv: encrypted.iv,
    orgKeyAuthTag: encrypted.authTag,
    hkdfSalt: hexEncode(salt),
    wrapVersion: CURRENT_ORG_WRAP_VERSION,
    keyVersion,
  };
}

// ─── Org Entry Encryption/Decryption ────────────────────────────

/**
 * Encrypt org entry data (text) with org encryption key.
 * Uses AES-256-GCM with AAD from crypto-aad.ts (buildOrgEntryAAD).
 */
export async function encryptOrgEntry(
  plaintext: string,
  orgEncryptionKey: CryptoKey,
  aad?: Uint8Array
): Promise<EncryptedData> {
  return encryptData(plaintext, orgEncryptionKey, aad);
}

/**
 * Decrypt org entry data (text) with org encryption key.
 */
export async function decryptOrgEntry(
  encrypted: EncryptedData,
  orgEncryptionKey: CryptoKey,
  aad?: Uint8Array
): Promise<string> {
  return decryptData(encrypted, orgEncryptionKey, aad);
}

/**
 * Encrypt org attachment (binary) with org encryption key.
 */
export async function encryptOrgAttachment(
  data: ArrayBuffer,
  orgEncryptionKey: CryptoKey,
  aad?: Uint8Array
): Promise<EncryptedBinary> {
  return encryptBinary(data, orgEncryptionKey, aad);
}

/**
 * Decrypt org attachment (binary) with org encryption key.
 */
export async function decryptOrgAttachment(
  encrypted: EncryptedBinary,
  orgEncryptionKey: CryptoKey,
  aad?: Uint8Array
): Promise<ArrayBuffer> {
  return decryptBinary(encrypted, orgEncryptionKey, aad);
}

// ─── Re-exports for convenience ─────────────────────────────────

export {
  generateECDHKeyPair,
  exportPublicKey,
  importPublicKey,
  exportPrivateKey,
  importPrivateKey,
} from "./crypto-emergency";

export type { EncryptedData, EncryptedBinary } from "./crypto-client";
export { hexEncode, hexDecode } from "./crypto-client";
