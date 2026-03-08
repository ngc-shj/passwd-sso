/**
 * Team E2E Encryption for browser extension.
 *
 * Ported from src/lib/crypto-team.ts and src/lib/crypto-aad.ts.
 * Only includes functions needed for decryption (read-only in extension).
 *
 * Key derivation chain:
 *   ECDH(ephemeral, member) → HKDF("passwd-sso-team-v1", salt) → AES-256-GCM wrapping key
 *   teamKey → HKDF("passwd-sso-team-enc-v1", empty) → AES-256-GCM encryption key
 *   itemKey → HKDF("passwd-sso-item-enc-v1", empty) → AES-256-GCM encryption key
 */

import { hexDecode, type EncryptedData } from "./crypto";

// ─── Constants ──────────────────────────────────────────────────

const AES_KEY_LENGTH = 256;
const AAD_VERSION = 1;

/** HKDF info for team key wrapping (ECDH → AES key) */
const HKDF_TEAM_WRAP_INFO = "passwd-sso-team-v1";

/** HKDF info for team entry encryption (teamKey → AES key) */
const HKDF_TEAM_ENC_INFO = "passwd-sso-team-enc-v1";

/** HKDF info for ECDH private key wrapping (secretKey → ecdhWrappingKey) */
const HKDF_ECDH_WRAP_INFO = "passwd-sso-ecdh-v1";

/** HKDF info for ItemKey → entry encryption key */
const HKDF_ITEM_ENC_INFO = "passwd-sso-item-enc-v1";

/** AAD scope for TeamMemberKey wrapping */
const AAD_SCOPE_TEAM_KEY = "OK";

/** AAD scope for Team Vault entry */
const SCOPE_TEAM = "OV";

/** AAD scope for ItemKey wrapping */
const SCOPE_ITEM_KEY = "IK";

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

// ─── AAD Builders ───────────────────────────────────────────────

function buildAADBytes(
  scope: string,
  expectedFieldCount: number,
  fields: string[]
): Uint8Array {
  if (scope.length !== 2) {
    throw new Error(`AAD scope must be exactly 2 ASCII chars, got "${scope}"`);
  }
  if (fields.length !== expectedFieldCount) {
    throw new Error(
      `AAD scope "${scope}" expects ${expectedFieldCount} fields, got ${fields.length}`
    );
  }

  const encoder = new TextEncoder();
  const encodedFields = fields.map((f) => encoder.encode(f));

  const headerSize = 4;
  const fieldsSize = encodedFields.reduce(
    (sum, ef) => sum + 2 + ef.length,
    0
  );
  const totalSize = headerSize + fieldsSize;

  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  let offset = 0;
  bytes[offset] = scope.charCodeAt(0);
  bytes[offset + 1] = scope.charCodeAt(1);
  offset += 2;

  view.setUint8(offset, AAD_VERSION);
  offset += 1;

  view.setUint8(offset, fields.length);
  offset += 1;

  for (const encoded of encodedFields) {
    view.setUint16(offset, encoded.length, false);
    offset += 2;
    bytes.set(encoded, offset);
    offset += encoded.length;
  }

  return bytes;
}

/** Build AAD for Team Vault entry encryption (scope "OV") */
export function buildTeamEntryAAD(
  teamId: string,
  entryId: string,
  vaultType: "blob" | "overview" = "blob",
  itemKeyVersion: number = 0
): Uint8Array {
  return buildAADBytes(SCOPE_TEAM, 4, [
    teamId,
    entryId,
    vaultType,
    String(itemKeyVersion),
  ]);
}

/** Build AAD for ItemKey wrapping (scope "IK") */
export function buildItemKeyWrapAAD(
  teamId: string,
  entryId: string,
  teamKeyVersion: number
): Uint8Array {
  return buildAADBytes(SCOPE_ITEM_KEY, 3, [
    teamId,
    entryId,
    String(teamKeyVersion),
  ]);
}

/** Build AAD for TeamMemberKey wrapping (scope "OK") */
export interface TeamKeyWrapContext {
  teamId: string;
  toUserId: string;
  keyVersion: number;
  wrapVersion: number;
}

export function buildTeamKeyWrapAAD(ctx: TeamKeyWrapContext): Uint8Array {
  return buildAADBytes(AAD_SCOPE_TEAM_KEY, 4, [
    ctx.teamId,
    ctx.toUserId,
    String(ctx.keyVersion),
    String(ctx.wrapVersion),
  ]);
}

// ─── ECDH Public Key Import ─────────────────────────────────────

async function importPublicKey(jwkString: string): Promise<CryptoKey> {
  const jwk = JSON.parse(jwkString) as JsonWebKey;
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
}

// ─── ECDH Private Key Import ────────────────────────────────────

export async function importEcdhPrivateKey(
  privateKeyBytes: Uint8Array
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(privateKeyBytes),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
}

// ─── ECDH Wrapping Key Derivation ───────────────────────────────

/**
 * Derive ecdhWrappingKey from secretKey for unwrapping ECDH private key.
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

// ─── ECDH Private Key Unwrapping ────────────────────────────────

/**
 * Unwrap ECDH private key bytes from vault data.
 * Uses ecdhWrappingKey derived from secretKey.
 */
export async function unwrapEcdhPrivateKey(
  encrypted: EncryptedData,
  ecdhWrappingKey: CryptoKey
): Promise<Uint8Array> {
  const ciphertext = hexDecode(encrypted.ciphertext);
  const iv = hexDecode(encrypted.iv);
  const authTag = hexDecode(encrypted.authTag);

  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext);
  combined.set(authTag, ciphertext.length);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    ecdhWrappingKey,
    toArrayBuffer(combined)
  );

  return new Uint8Array(decrypted);
}

// ─── Team Wrapping Key Derivation (ECDH + HKDF) ─────────────────

async function deriveTeamWrappingKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  salt: Uint8Array
): Promise<CryptoKey> {
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

// ─── Team Key Unwrapping ─────────────────────────────────────────

/**
 * Unwrap team symmetric key as a member.
 * Member uses their ECDH private key + admin's ephemeral public key.
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

// ─── Team Encryption Key Derivation ──────────────────────────────

/**
 * Derive AES-256-GCM encryption key from team symmetric key.
 * HKDF(teamKey, info="passwd-sso-team-enc-v1", salt=empty)
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
      salt: new ArrayBuffer(32),
      info: textEncode(HKDF_TEAM_ENC_INFO),
    },
    hkdfKey,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  );
}

// ─── ItemKey Unwrapping ──────────────────────────────────────────

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

// ─── ItemKey Encryption Key Derivation ───────────────────────────

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
      salt: new ArrayBuffer(32),
      info: textEncode(HKDF_ITEM_ENC_INFO),
    },
    hkdfKey,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  );
}
