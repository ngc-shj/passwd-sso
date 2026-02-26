/**
 * Team E2E Encryption (ECDH-P256)
 *
 * Provides client-side encryption for organization vault entries using
 * ECDH key exchange for per-member team key distribution.
 *
 * Key derivation chain:
 *   ECDH(ephemeral, member) → HKDF("passwd-sso-org-v1", random salt) → AES-256-GCM wrapping key
 *   teamKey → HKDF("passwd-sso-org-enc-v1", empty) → AES-256-GCM encryption key
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

/** HKDF info for team key wrapping (ECDH → AES key) */
const HKDF_TEAM_WRAP_INFO = "passwd-sso-org-v1";

/** HKDF info for team entry encryption (teamKey → AES key) */
const HKDF_TEAM_ENC_INFO = "passwd-sso-org-enc-v1";

/** HKDF info for ECDH private key wrapping (secretKey → ecdhWrappingKey) */
export const HKDF_ECDH_WRAP_INFO = "passwd-sso-ecdh-v1";

export const CURRENT_TEAM_WRAP_VERSION = 1;

/** AAD scope for TeamMemberKey wrapping */
const AAD_SCOPE_ORG_KEY = "OK";

/** AAD version for team key wrapping */
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

// ─── Team Symmetric Key Generation ───────────────────────────────

/** Generate a random 256-bit team symmetric key */
export function generateTeamSymmetricKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

// ─── Team Encryption Key Derivation ──────────────────────────────

/**
 * Derive AES-256-GCM encryption key from team symmetric key.
 * HKDF(teamKey, info="passwd-sso-org-enc-v1", salt=empty)
 *
 * Salt is empty because teamKey itself is unique per team (256-bit random).
 */
export async function deriveTeamEncryptionKey(
  teamKey: Uint8Array
): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(teamKey),
    "HKDF",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new ArrayBuffer(32), // empty salt — teamKey has sufficient entropy
      info: textEncode(HKDF_TEAM_ENC_INFO),
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
 * The random salt is generated per key-wrapping operation and stored in TeamMemberKey.
 * Team-level domain separation is enforced via AAD (which includes teamId).
 */
async function deriveTeamWrappingKey(
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
      info: textEncode(HKDF_TEAM_WRAP_INFO),
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

// ─── AAD for TeamMemberKey Wrapping ──────────────────────────────

export interface TeamKeyWrapContext {
  teamId: string;
  toUserId: string;
  keyVersion: number;
  wrapVersion: number;
}

/**
 * Build AAD for TeamMemberKey wrapping.
 * Binary format (same as crypto-aad.ts buildAADBytes):
 *   [scope: 2B "OK"] [aadVersion: 1B] [nFields: 1B=4]
 *   [field_len: 2B BE] [field: N bytes] × 4
 *
 * Fields: teamId | toUserId | keyVersion | wrapVersion
 * Prevents cross-team, cross-user, and cross-version transplant attacks.
 */
export function buildTeamKeyWrapAAD(ctx: TeamKeyWrapContext): Uint8Array {
  const fields = [
    ctx.teamId,
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

// ─── Team Key Wrapping (Admin → Member) ──────────────────────────

/**
 * Wrap team symmetric key for a member using ECDH.
 * Admin generates ephemeral key pair → ECDH with member's public key → AES-GCM wrap.
 */
export async function wrapTeamKeyForMember(
  teamKey: Uint8Array,
  ephemeralPrivateKey: CryptoKey,
  memberPublicKey: CryptoKey,
  hkdfSalt: Uint8Array,
  ctx: TeamKeyWrapContext
): Promise<EncryptedData> {
  const wrappingKey = await deriveTeamWrappingKey(
    ephemeralPrivateKey,
    memberPublicKey,
    hkdfSalt
  );

  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const aad = buildTeamKeyWrapAAD(ctx);

  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(aad),
    },
    wrappingKey,
    toArrayBuffer(teamKey)
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
 * Unwrap team symmetric key as a member.
 * Member uses their ECDH private key + admin's ephemeral public key → AES-GCM unwrap.
 *
 * @param hkdfSalt - Hex-encoded HKDF salt (stored in TeamMemberKey.hkdfSalt)
 */
export async function unwrapTeamKey(
  encrypted: EncryptedData,
  ephemeralPublicKeyJwk: string,
  memberPrivateKey: CryptoKey,
  hkdfSalt: string,
  ctx: TeamKeyWrapContext
): Promise<Uint8Array> {
  const ephemeralPublicKey = await importPublicKey(ephemeralPublicKeyJwk);
  const salt = hexDecode(hkdfSalt);

  const wrappingKey = await deriveTeamWrappingKey(
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

  const aad = buildTeamKeyWrapAAD(ctx);

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

export interface TeamKeyEscrowResult {
  ephemeralPublicKey: string;
  encryptedOrgKey: string;
  teamKeyIv: string;
  teamKeyAuthTag: string;
  hkdfSalt: string;
  wrapVersion: number;
  keyVersion: number;
}

/**
 * Create team key escrow for a member.
 * Generates ephemeral ECDH key pair, wraps team key, returns all fields for storage.
 *
 * @param teamKey - Plaintext team symmetric key
 * @param memberPublicKeyJwk - Member's ECDH public key (JWK string)
 * @param teamId - Organization ID
 * @param toUserId - Member user ID
 * @param keyVersion - Team key version
 */
export async function createTeamKeyEscrow(
  teamKey: Uint8Array,
  memberPublicKeyJwk: string,
  teamId: string,
  toUserId: string,
  keyVersion: number
): Promise<TeamKeyEscrowResult> {
  const ephemeralKeyPair = await generateECDHKeyPair();
  const memberPublicKey = await importPublicKey(memberPublicKeyJwk);

  // Random HKDF salt — used in ECDH wrapping key derivation, stored in TeamMemberKey
  const salt = crypto.getRandomValues(new Uint8Array(HKDF_SALT_LENGTH));

  const ctx: TeamKeyWrapContext = {
    teamId,
    toUserId,
    keyVersion,
    wrapVersion: CURRENT_TEAM_WRAP_VERSION,
  };

  const encrypted = await wrapTeamKeyForMember(
    teamKey,
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
    teamKeyIv: encrypted.iv,
    teamKeyAuthTag: encrypted.authTag,
    hkdfSalt: hexEncode(salt),
    wrapVersion: CURRENT_TEAM_WRAP_VERSION,
    keyVersion,
  };
}

// ─── Team Entry Encryption/Decryption ────────────────────────────

/**
 * Encrypt team entry data (text) with team encryption key.
 * Uses AES-256-GCM with AAD from crypto-aad.ts (buildTeamEntryAAD).
 */
export async function encryptTeamEntry(
  plaintext: string,
  teamEncryptionKey: CryptoKey,
  aad?: Uint8Array
): Promise<EncryptedData> {
  return encryptData(plaintext, teamEncryptionKey, aad);
}

/**
 * Decrypt team entry data (text) with team encryption key.
 */
export async function decryptTeamEntry(
  encrypted: EncryptedData,
  teamEncryptionKey: CryptoKey,
  aad?: Uint8Array
): Promise<string> {
  return decryptData(encrypted, teamEncryptionKey, aad);
}

/**
 * Encrypt team attachment (binary) with team encryption key.
 */
export async function encryptTeamAttachment(
  data: ArrayBuffer,
  teamEncryptionKey: CryptoKey,
  aad?: Uint8Array
): Promise<EncryptedBinary> {
  return encryptBinary(data, teamEncryptionKey, aad);
}

/**
 * Decrypt team attachment (binary) with team encryption key.
 */
export async function decryptTeamAttachment(
  encrypted: EncryptedBinary,
  teamEncryptionKey: CryptoKey,
  aad?: Uint8Array
): Promise<ArrayBuffer> {
  return decryptBinary(encrypted, teamEncryptionKey, aad);
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
