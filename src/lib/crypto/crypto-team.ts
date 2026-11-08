/**
 * Team E2E Encryption (ECDH-P256)
 *
 * Provides client-side encryption for team vault entries using
 * ECDH key exchange for per-member team key distribution.
 *
 * Key derivation chain:
 *   ECDH(ephemeral, member) → HKDF("passwd-sso-team-v1", random salt) → AES-256-GCM wrapping key
 *   teamKey → HKDF("passwd-sso-team-enc-v1", empty) → AES-256-GCM encryption key
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
import { toArrayBuffer, textEncode } from "./crypto-utils";
import {
  AAD_VERSION,
  buildTeamAttachmentCekWrapAAD,
  buildTeamEntryAAD,
  buildTeamKeyWrapAAD,
  type TeamKeyWrapContext,
  type VaultType,
} from "./crypto-aad";

// Re-export so callers importing TeamKeyWrapContext from crypto-team still work.
export type { TeamKeyWrapContext };

import { AES_KEY_LENGTH, IV_LENGTH, AUTH_TAG_LENGTH } from "./crypto-params";

// ─── Constants ──────────────────────────────────────────────────

const HKDF_SALT_LENGTH = 32;

/** HKDF info for team key wrapping (ECDH → AES key) */
const HKDF_TEAM_WRAP_INFO = "passwd-sso-team-v1";

/** HKDF info for team entry encryption (teamKey → AES key) */
const HKDF_TEAM_ENC_INFO = "passwd-sso-team-enc-v1";

/** HKDF info for ECDH private key wrapping (secretKey → ecdhWrappingKey) */
export const HKDF_ECDH_WRAP_INFO = "passwd-sso-ecdh-v1";

export const CURRENT_TEAM_WRAP_VERSION = 1;

// ─── Team Symmetric Key Generation ───────────────────────────────

/** Generate a random 256-bit team symmetric key */
export function generateTeamSymmetricKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

// ─── Team Encryption Key Derivation ──────────────────────────────

/**
 * Derive AES-256-GCM encryption key from team symmetric key.
 * HKDF(teamKey, info="passwd-sso-team-enc-v1", salt=empty)
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
      salt: new Uint8Array(32), // empty salt — teamKey has sufficient entropy
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
 * HKDF(sharedBits, info="passwd-sso-team-v1", salt=random per-escrow salt)
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
      salt: new Uint8Array(32),
      info: textEncode(HKDF_ECDH_WRAP_INFO),
    },
    hkdfKey,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  );
}

// buildTeamKeyWrapAAD is imported from crypto-aad (single registry).
// Re-export it so callers importing from crypto-team stay unchanged.
export { buildTeamKeyWrapAAD };

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
  const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - AUTH_TAG_LENGTH);
  const authTag = encryptedBytes.slice(encryptedBytes.length - AUTH_TAG_LENGTH);

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
  encryptedTeamKey: string;
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
 * @param teamId - Team ID
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
    encryptedTeamKey: encrypted.ciphertext,
    teamKeyIv: encrypted.iv,
    teamKeyAuthTag: encrypted.authTag,
    hkdfSalt: hexEncode(salt),
    wrapVersion: CURRENT_TEAM_WRAP_VERSION,
    keyVersion,
  };
}

// ─── Team Entry Encryption/Decryption ────────────────────────────

/**
 * Where a team entry blob / overview is bound: the team entry AAD ("OV")
 * at the entry's ItemKey version. Every field is required — there is no
 * optional-AAD path through the strict helpers.
 */
export interface TeamEntryAadContext {
  teamId: string;
  entryId: string;
  vaultType: VaultType;
  itemKeyVersion: number;
}

function teamEntryAAD(ctx: TeamEntryAadContext): Uint8Array {
  return buildTeamEntryAAD(ctx.teamId, ctx.entryId, ctx.vaultType, ctx.itemKeyVersion);
}

/**
 * Seal a team entry field at the team entry AAD. The only web path that
 * encrypts team entry text (team-entry-aad-strictness.test.ts, plan C5/C7).
 */
export async function sealTeamEntryField(
  plaintext: string,
  key: CryptoKey,
  ctx: TeamEntryAadContext
): Promise<EncryptedData> {
  return encryptData(plaintext, key, teamEntryAAD(ctx));
}

/**
 * Open a team entry field at the team entry AAD, whatever `aadVersion` the
 * server reports for the row. Mirrored by openTeamEntryField in
 * extension/src/lib/crypto-team.ts — keep the two in step.
 */
export async function openTeamEntryField(
  encrypted: EncryptedData,
  key: CryptoKey,
  ctx: TeamEntryAadContext
): Promise<string> {
  return decryptData(encrypted, key, teamEntryAAD(ctx));
}

/**
 * Open a team entry field at the AAD its server-reported `aadVersion` names:
 * 0 → no AAD (a row written before AAD binding), AAD_VERSION (1) → the team
 * entry AAD; anything else (an unknown version, a non-number) throws.
 * Trusting `aadVersion` lets a server label a row 0 and substitute a no-AAD
 * ciphertext, so it may be called only from the paths that upgrade such a row
 * or only display it (plan C6; the guard confines the call sites).
 */
export async function openTeamEntryFieldAt(
  encrypted: EncryptedData,
  key: CryptoKey,
  ctx: TeamEntryAadContext,
  aadVersion: unknown
): Promise<string> {
  if (aadVersion === 0) return decryptData(encrypted, key);
  if (aadVersion === AAD_VERSION) return decryptData(encrypted, key, teamEntryAAD(ctx));
  throw new Error("Unsupported team entry aadVersion");
}

/**
 * Open a team entry field sealed without AAD (a legacy history row). Called
 * only where openTeamEntryFieldAt may be (plan C6).
 */
export async function openLegacyTeamEntryField(
  encrypted: EncryptedData,
  key: CryptoKey
): Promise<string> {
  return decryptData(encrypted, key);
}

/**
 * Seal a team entry field WITHOUT AAD: a legacy history row re-sealed under a
 * new ItemKey stays a row the history restore refuses (D80). Confined to
 * resealLegacyHistoryRow (plan C6).
 */
export async function sealLegacyTeamEntryField(
  plaintext: string,
  key: CryptoKey
): Promise<EncryptedData> {
  return encryptData(plaintext, key);
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

// ─── ItemKey Hierarchy ───────────────────────────────────────────

/** HKDF info for ItemKey → entry/attachment encryption key */
export const HKDF_ITEM_ENC_INFO = "passwd-sso-item-enc-v1";

/** Generate a random 256-bit ItemKey for a team password entry */
export function generateItemKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Derive AES-256-GCM encryption key from ItemKey.
 * HKDF(itemKey, info="passwd-sso-item-enc-v1", salt=empty)
 */
export async function deriveItemEncryptionKey(
  itemKey: Uint8Array
): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(itemKey),
    "HKDF",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: textEncode(HKDF_ITEM_ENC_INFO),
    },
    hkdfKey,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  );
}

/** HKDF info for ItemKey → team attachment CEK-wrap key */
export const HKDF_ITEM_CEKWRAP_INFO = "passwd-sso-item-cekwrap-v1";

/**
 * Derive the AES-256-GCM key that wraps team attachment CEKs (mode-2).
 * HKDF(itemKey, info="passwd-sso-item-cekwrap-v1", salt=empty) — a separate
 * domain from the entry content key, so a CEK wrap never shares a key with
 * entry ciphertext.
 */
export async function deriveItemCekWrapKey(
  itemKey: Uint8Array
): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(itemKey),
    "HKDF",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: textEncode(HKDF_ITEM_CEKWRAP_INFO),
    },
    hkdfKey,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Where a team attachment CEK wrap is bound (scope "TW"). */
export interface TeamAttachmentCekWrapContext {
  teamId: string;
  entryId: string;
  attachmentId: string;
  itemKeyVersion: number;
  cekWrapAadVersion: number;
}

function teamAttachmentCekWrapAAD(ctx: TeamAttachmentCekWrapContext): Uint8Array {
  return buildTeamAttachmentCekWrapAAD(
    ctx.teamId,
    ctx.entryId,
    ctx.attachmentId,
    ctx.itemKeyVersion,
    ctx.cekWrapAadVersion,
  );
}

/**
 * Wrap a raw attachment CEK with the ItemKey's CEK-wrap key
 * (deriveItemCekWrapKey) under the "TW" AAD.
 */
export async function wrapTeamAttachmentCek(
  cekRaw: Uint8Array,
  cekWrapKey: CryptoKey,
  ctx: TeamAttachmentCekWrapContext
): Promise<EncryptedBinary> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(iv),
        additionalData: toArrayBuffer(teamAttachmentCekWrapAAD(ctx)),
      },
      cekWrapKey,
      toArrayBuffer(cekRaw)
    )
  );
  return {
    ciphertext: encrypted.slice(0, encrypted.length - AUTH_TAG_LENGTH),
    iv: hexEncode(iv),
    authTag: hexEncode(encrypted.slice(encrypted.length - AUTH_TAG_LENGTH)),
  };
}

/**
 * Unwrap a team attachment CEK, verifying the "TW" AAD. Returns the raw CEK
 * bytes; the caller zeroes them after import.
 */
export async function unwrapTeamAttachmentCek(
  wrapped: EncryptedBinary,
  cekWrapKey: CryptoKey,
  ctx: TeamAttachmentCekWrapContext
): Promise<Uint8Array> {
  return new Uint8Array(
    await decryptBinary(wrapped, cekWrapKey, teamAttachmentCekWrapAAD(ctx))
  );
}

/**
 * Wrap ItemKey with TeamKey (AES-256-GCM) using AAD to prevent transplant.
 */
export async function wrapItemKey(
  itemKey: Uint8Array,
  teamEncryptionKey: CryptoKey,
  aad: Uint8Array
): Promise<EncryptedData> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(aad),
    },
    teamEncryptionKey,
    toArrayBuffer(itemKey)
  );

  const encryptedBytes = new Uint8Array(encrypted);
  const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - AUTH_TAG_LENGTH);
  const authTag = encryptedBytes.slice(encryptedBytes.length - AUTH_TAG_LENGTH);

  return {
    ciphertext: hexEncode(ciphertext),
    iv: hexEncode(iv),
    authTag: hexEncode(authTag),
  };
}

/**
 * Unwrap ItemKey with TeamKey (AES-256-GCM), verifying AAD.
 */
export async function unwrapItemKey(
  encrypted: EncryptedData,
  teamEncryptionKey: CryptoKey,
  aad: Uint8Array
): Promise<Uint8Array> {
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
      additionalData: toArrayBuffer(aad),
    },
    teamEncryptionKey,
    toArrayBuffer(combined)
  );

  return new Uint8Array(decrypted);
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
