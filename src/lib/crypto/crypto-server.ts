/**
 * Server-side cryptography module.
 *
 * Used for share links, sends, and passphrase verification.
 * Team vault encryption is fully E2E (client-side) via crypto-team.ts.
 *
 * Key hierarchy for shares/sends:
 *   SHARE_MASTER_KEY_V{N} (env, 256-bit hex, versioned)
 *     -> AES-256-GCM -> PasswordShare / Send encrypted data
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
import { getKeyProviderSync } from "@/lib/key-provider";
import { getCurrentVerifierVersion } from "@/lib/crypto/verifier-version";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits, recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits

export interface ServerEncryptedData {
  ciphertext: string; // hex
  iv: string; // hex (24 chars)
  authTag: string; // hex (32 chars)
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "WRONG_PASSPHRASE" | "MISSING_PEPPER_VERSION" };

// ─── Master Key (Versioned) ──────────────────────────────────────

/** Get the current master key version from env. Defaults to 1. */
export function getCurrentMasterKeyVersion(): number {
  const raw = process.env.SHARE_MASTER_KEY_CURRENT_VERSION;
  if (!raw) return 1;
  const version = parseInt(raw, 10);
  if (!Number.isFinite(version) || version < 1) {
    throw new Error("SHARE_MASTER_KEY_CURRENT_VERSION must be a positive integer");
  }
  return version;
}

/**
 * Get the master key for a specific version.
 *
 * For V1: prefers SHARE_MASTER_KEY_V1, falls back to SHARE_MASTER_KEY.
 * For V2+: requires SHARE_MASTER_KEY_V{version}.
 */
export function getMasterKeyByVersion(version: number): Buffer {
  return getKeyProviderSync().getKeySync("share-master", version);
}

// ─── Data Encryption / Decryption ───────────────────────────────

/** Encrypt plaintext JSON with an team key (AES-256-GCM). Optional AAD for binding context. */
export function encryptServerData(
  plaintext: string,
  teamKey: Buffer,
  aad?: Buffer
): ServerEncryptedData {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, teamKey, iv, {
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

/** Decrypt ciphertext with an team key (AES-256-GCM). Optional AAD must match encryption. */
export function decryptServerData(
  encrypted: ServerEncryptedData,
  teamKey: Buffer,
  aad?: Buffer
): string {
  const iv = Buffer.from(encrypted.iv, "hex");
  const authTag = Buffer.from(encrypted.authTag, "hex");
  const ciphertext = Buffer.from(encrypted.ciphertext, "hex");

  const decipher = createDecipheriv(ALGORITHM, teamKey, iv, {
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

/** Encrypt binary data (Buffer) with an team key (AES-256-GCM). Optional AAD for binding context. */
export function encryptServerBinary(
  data: Buffer,
  teamKey: Buffer,
  aad?: Buffer
): ServerEncryptedBinary {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, teamKey, iv, {
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

/** Decrypt binary data with an team key (AES-256-GCM). Optional AAD must match encryption. */
export function decryptServerBinary(
  encrypted: ServerEncryptedBinary,
  teamKey: Buffer,
  aad?: Buffer
): Buffer {
  const iv = Buffer.from(encrypted.iv, "hex");
  const authTag = Buffer.from(encrypted.authTag, "hex");

  const decipher = createDecipheriv(ALGORITHM, teamKey, iv, {
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

/**
 * Encrypt share data with the current server-side master key (AES-256-GCM).
 *
 * IMPORTANT: This is NOT end-to-end encryption. The server holds the master key
 * and can decrypt this data. Used for Sends and personal share links where the
 * server mediates access. For true E2E encryption, use the client-side crypto
 * in crypto-client.ts (vault entries, team share links with masterKeyVersion=0).
 */
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

/**
 * Encrypt binary data with the current server-side master key (AES-256-GCM).
 *
 * IMPORTANT: This is server-side encryption, not E2E. See encryptShareData() for details.
 */
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

// ─── Access Password (for password-protected shares) ────────────

/** Generate a 32-byte random access password as base64url (43 chars). */
export function generateAccessPassword(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Hash an access password for storage.
 * Pre-hashes with SHA-256 to produce 64-char hex required by hmacVerifier.
 *
 * NOTE: SHA-256 is intentional here — the input is a server-generated
 * 256-bit random token (randomBytes(32)), not a user-chosen password.
 * A slow KDF (bcrypt/argon2) is unnecessary for high-entropy secrets.
 */
export function hashAccessPassword(
  password: string,
  version: number = getCurrentVerifierVersion()
): { hash: string; version: number } {
  const digest = createHash("sha256").update(password).digest("hex");
  return { hash: hmacVerifier(digest, version), version };
}

/** Verify an access password against stored hash. Timing-safe. */
export function verifyAccessPassword(
  password: string,
  storedHash: string,
  storedVersion: number
): VerifyResult {
  const digest = createHash("sha256").update(password).digest("hex");
  return verifyPassphraseVerifier(digest, storedHash, storedVersion);
}

// ─── Passphrase Verifier (HMAC pepper) ──────────────────────────

const VERIFIER_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Get the verifier pepper key for a specific version.
 *
 * - V1: reads VERIFIER_PEPPER_KEY; falls back to derived key in dev/test.
 * - V2+: reads VERIFIER_PEPPER_KEY_V{version}; no dev fallback.
 * - In production, missing pepper throws.
 */
function getVerifierPepper(version: number = 1): Buffer {
  return getKeyProviderSync().getKeySync("verifier-pepper", version);
}

/**
 * HMAC(pepper, verifierHash) — for DB storage.
 * Prevents offline dictionary attacks if the DB is leaked.
 *
 * Input is normalized to lowercase and validated as 64-char hex.
 * Throws on invalid input (caller should validate before saving).
 */
export function hmacVerifier(
  verifierHashHex: string,
  version: number = getCurrentVerifierVersion()
): string {
  const normalized = verifierHashHex.toLowerCase();
  if (!VERIFIER_HEX_RE.test(normalized)) {
    throw new Error("verifierHash must be a 64-char lowercase hex string");
  }
  const pepper = getVerifierPepper(version);
  return createHmac("sha256", pepper).update(normalized).digest("hex");
}

/**
 * Verify a client-provided verifier hash against the stored HMAC.
 * Uses timingSafeEqual to prevent timing attacks.
 *
 * Returns VerifyResult instead of boolean:
 * - { ok: true } on match
 * - { ok: false, reason: "WRONG_PASSPHRASE" } on mismatch or corrupted input
 * - { ok: false, reason: "MISSING_PEPPER_VERSION" } if pepper for storedVersion is not configured
 */
export function verifyPassphraseVerifier(
  clientVerifierHash: string,
  storedHmacHex: string,
  storedVersion: number
): VerifyResult {
  try {
    const normalized = clientVerifierHash.toLowerCase();
    if (!VERIFIER_HEX_RE.test(normalized)) return { ok: false, reason: "WRONG_PASSPHRASE" };

    const storedNormalized = storedHmacHex.toLowerCase();
    if (!VERIFIER_HEX_RE.test(storedNormalized)) return { ok: false, reason: "WRONG_PASSPHRASE" };

    let computed: string;
    try {
      computed = hmacVerifier(normalized, storedVersion);
    } catch (pepperErr) {
      // Pepper for storedVersion is not configured — fail with a distinct reason
      // so callers can emit the appropriate audit event.
      if (
        pepperErr instanceof Error &&
        pepperErr.message.includes("not found or invalid") ||
        pepperErr instanceof Error &&
        pepperErr.message.includes("required") ||
        pepperErr instanceof Error &&
        pepperErr.message.includes("no fallback")
      ) {
        return { ok: false, reason: "MISSING_PEPPER_VERSION" };
      }
      return { ok: false, reason: "MISSING_PEPPER_VERSION" };
    }

    const a = Buffer.from(computed, "hex");
    const b = Buffer.from(storedNormalized, "hex");
    if (a.length !== b.length) return { ok: false, reason: "WRONG_PASSPHRASE" };
    return timingSafeEqual(a, b)
      ? { ok: true }
      : { ok: false, reason: "WRONG_PASSPHRASE" };
  } catch {
    // Corrupted stored value — fail closed as wrong passphrase
    return { ok: false, reason: "WRONG_PASSPHRASE" };
  }
}
