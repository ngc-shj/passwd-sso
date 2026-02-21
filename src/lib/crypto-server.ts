/**
 * Server-side cryptography module for organization vault.
 *
 * Key hierarchy:
 *   ORG_MASTER_KEY_V{N} (env, 256-bit hex, versioned)
 *     -> AES-256-GCM wrap -> per-org key (Organization.encryptedOrgKey)
 *       -> AES-256-GCM -> OrgPasswordEntry.encryptedBlob / encryptedOverview
 *
 * Versioned master key support:
 *   - ORG_MASTER_KEY alone → treated as V1 (backward compatible)
 *   - ORG_MASTER_KEY_V1 takes precedence over ORG_MASTER_KEY when both set
 *   - ORG_MASTER_KEY_CURRENT_VERSION controls which version is used for new encryptions
 *
 * Uses node:crypto (NOT Web Crypto API — this runs server-side only).
 */

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits, recommended for GCM
const KEY_LENGTH = 32; // 256 bits
const AUTH_TAG_LENGTH = 16; // 128 bits
const HEX64_RE = /^[0-9a-fA-F]{64}$/;

export interface ServerEncryptedData {
  ciphertext: string; // hex
  iv: string; // hex (24 chars)
  authTag: string; // hex (32 chars)
}

export interface WrappedOrgKey extends ServerEncryptedData {
  masterKeyVersion: number;
}

// ─── Master Key (Versioned) ──────────────────────────────────────

/** Get the current master key version from env. Defaults to 1. */
export function getCurrentMasterKeyVersion(): number {
  const raw = process.env.ORG_MASTER_KEY_CURRENT_VERSION;
  if (!raw) return 1;
  const version = parseInt(raw, 10);
  if (!Number.isFinite(version) || version < 1) {
    throw new Error("ORG_MASTER_KEY_CURRENT_VERSION must be a positive integer");
  }
  return version;
}

/**
 * Get the master key for a specific version.
 *
 * For V1: prefers ORG_MASTER_KEY_V1, falls back to ORG_MASTER_KEY.
 * For V2+: requires ORG_MASTER_KEY_V{version}.
 */
export function getMasterKeyByVersion(version: number): Buffer {
  let hex: string | undefined;

  if (version === 1) {
    hex = process.env.ORG_MASTER_KEY_V1 ?? process.env.ORG_MASTER_KEY;
  } else {
    hex = process.env[`ORG_MASTER_KEY_V${version}`];
  }

  if (!hex || !HEX64_RE.test(hex)) {
    throw new Error(
      `Master key for version ${version} not found or invalid (expected 64-char hex)`
    );
  }
  return Buffer.from(hex, "hex");
}

/** Get the current master key (shorthand for getMasterKeyByVersion(currentVersion)). */
function getMasterKey(): Buffer {
  return getMasterKeyByVersion(getCurrentMasterKeyVersion());
}

// ─── Per-Org Key Management ─────────────────────────────────────

/** Generate a random 256-bit organization key. */
export function generateOrgKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

/** Wrap (encrypt) an org key with the current master key. */
export function wrapOrgKey(orgKey: Buffer): WrappedOrgKey {
  const version = getCurrentMasterKeyVersion();
  const masterKey = getMasterKeyByVersion(version);
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
    masterKeyVersion: version,
  };
}

/** Unwrap (decrypt) an org key using the specified master key version. */
export function unwrapOrgKey(wrapped: ServerEncryptedData, masterKeyVersion: number): Buffer {
  const masterKey = getMasterKeyByVersion(masterKeyVersion);
  const iv = Buffer.from(wrapped.iv, "hex");
  const authTag = Buffer.from(wrapped.authTag, "hex");
  const ciphertext = Buffer.from(wrapped.ciphertext, "hex");

  const decipher = createDecipheriv(ALGORITHM, masterKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Re-wrap an org key from one master key version to another.
 * Decrypts with fromVersion, then encrypts with toVersion.
 * Zeroizes the plaintext org key buffer after use.
 */
export function rewrapOrgKey(
  wrapped: ServerEncryptedData,
  fromVersion: number,
  toVersion: number
): WrappedOrgKey {
  const plainOrgKey = unwrapOrgKey(wrapped, fromVersion);
  try {
    const toMasterKey = getMasterKeyByVersion(toVersion);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, toMasterKey, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });

    const ciphertext = Buffer.concat([cipher.update(plainOrgKey), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      ciphertext: ciphertext.toString("hex"),
      iv: iv.toString("hex"),
      authTag: authTag.toString("hex"),
      masterKeyVersion: toVersion,
    };
  } finally {
    plainOrgKey.fill(0);
  }
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

/** Encrypt share data with the current master key (AES-256-GCM). Returns masterKeyVersion for DB storage. */
export function encryptShareData(plaintext: string): ServerEncryptedData & { masterKeyVersion: number } {
  const version = getCurrentMasterKeyVersion();
  const masterKey = getMasterKeyByVersion(version);
  return { ...encryptServerData(plaintext, masterKey), masterKeyVersion: version };
}

/** Decrypt share data with the specified master key version (AES-256-GCM). */
export function decryptShareData(encrypted: ServerEncryptedData, masterKeyVersion: number): string {
  const masterKey = getMasterKeyByVersion(masterKeyVersion);
  return decryptServerData(encrypted, masterKey);
}

/** Encrypt binary data with the current master key (AES-256-GCM). Returns masterKeyVersion for DB storage. */
export function encryptShareBinary(data: Buffer): ServerEncryptedBinary & { masterKeyVersion: number } {
  const version = getCurrentMasterKeyVersion();
  const masterKey = getMasterKeyByVersion(version);
  return { ...encryptServerBinary(data, masterKey), masterKeyVersion: version };
}

/** Decrypt binary data with the specified master key version (AES-256-GCM). */
export function decryptShareBinary(encrypted: ServerEncryptedBinary, masterKeyVersion: number): Buffer {
  const masterKey = getMasterKeyByVersion(masterKeyVersion);
  return decryptServerBinary(encrypted, masterKey);
}

// ─── Passphrase Verifier (HMAC pepper) ──────────────────────────

const VERIFIER_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Get the verifier pepper key.
 *
 * - Prefers VERIFIER_PEPPER_KEY env var (64-char hex = 256-bit).
 * - In production, VERIFIER_PEPPER_KEY is **required** (throws on missing).
 * - In dev/test, falls back to SHA-256("verifier-pepper:" || ORG_MASTER_KEY).
 */
function getVerifierPepper(): Buffer {
  const pepperHex = process.env.VERIFIER_PEPPER_KEY;
  if (pepperHex) {
    if (!VERIFIER_HEX_RE.test(pepperHex.toLowerCase())) {
      throw new Error(
        "VERIFIER_PEPPER_KEY must be a 64-char hex string (256 bits)"
      );
    }
    return Buffer.from(pepperHex, "hex");
  }

  // Production requires explicit pepper — no silent fallback
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "VERIFIER_PEPPER_KEY is required in production"
    );
  }

  // Dev/test fallback: domain-separated derivation from master key V1
  return createHash("sha256")
    .update("verifier-pepper:")
    .update(getMasterKeyByVersion(1))
    .digest();
}

/**
 * HMAC(pepper, verifierHash) — for DB storage.
 * Prevents offline dictionary attacks if the DB is leaked.
 *
 * Input is normalized to lowercase and validated as 64-char hex.
 * Throws on invalid input (caller should validate before saving).
 */
export function hmacVerifier(verifierHashHex: string): string {
  const normalized = verifierHashHex.toLowerCase();
  if (!VERIFIER_HEX_RE.test(normalized)) {
    throw new Error("verifierHash must be a 64-char lowercase hex string");
  }
  const pepper = getVerifierPepper();
  return createHmac("sha256", pepper).update(normalized).digest("hex");
}

/**
 * Verify a client-provided verifier hash against the stored HMAC.
 * Uses timingSafeEqual to prevent timing attacks.
 *
 * Returns false (instead of throwing) if stored value is corrupted,
 * to avoid 500 errors in production.
 */
export function verifyPassphraseVerifier(
  clientVerifierHash: string,
  storedHmacHex: string
): boolean {
  try {
    const normalized = clientVerifierHash.toLowerCase();
    if (!VERIFIER_HEX_RE.test(normalized)) return false;

    const computed = hmacVerifier(normalized);
    const storedNormalized = storedHmacHex.toLowerCase();
    if (!VERIFIER_HEX_RE.test(storedNormalized)) return false;

    const a = Buffer.from(computed, "hex");
    const b = Buffer.from(storedNormalized, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    // Corrupted stored value or pepper issue — fail closed
    return false;
  }
}
