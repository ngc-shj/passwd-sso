/**
 * Node.js crypto helpers for E2E test seeding.
 *
 * Replicates crypto-client.ts (Web Crypto API) using Node.js native crypto.
 * All constants are imported from the single source of truth — no duplication.
 */
import {
  createCipheriv,
  createHash,
  createHmac,
  hkdfSync,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import { CRYPTO_CONSTANTS } from "../../src/lib/crypto-client";

export interface EncryptedData {
  ciphertext: string; // hex
  iv: string; // hex
  authTag: string; // hex
}

// ─── Hex Utilities ──────────────────────────────────────────────

export function hexEncode(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("hex");
}

export function hexDecode(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

// ─── Key Derivation ─────────────────────────────────────────────

/**
 * PBKDF2(passphrase, accountSalt, 600k) → 32-byte wrapping key
 */
export function deriveWrappingKey(
  passphrase: string,
  accountSalt: Buffer
): Buffer {
  return pbkdf2Sync(
    passphrase,
    accountSalt,
    CRYPTO_CONSTANTS.PBKDF2_ITERATIONS,
    32,
    "sha256"
  );
}

/**
 * HKDF(secretKey, empty-salt, enc-info) → 32-byte encryption key
 */
export function deriveEncryptionKey(secretKey: Buffer): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      secretKey,
      Buffer.alloc(32), // empty salt
      CRYPTO_CONSTANTS.HKDF_ENC_INFO,
      32
    )
  );
}

/**
 * HKDF(secretKey, empty-salt, auth-info) → 32-byte auth key
 */
export function deriveAuthKey(secretKey: Buffer): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      secretKey,
      Buffer.alloc(32),
      CRYPTO_CONSTANTS.HKDF_AUTH_INFO,
      32
    )
  );
}

// ─── AES-256-GCM ────────────────────────────────────────────────

/**
 * AES-256-GCM encrypt. Returns separate ciphertext + authTag (matching Web Crypto split).
 */
export function aesGcmEncrypt(
  key: Buffer,
  plaintext: Buffer,
  iv?: Buffer
): EncryptedData {
  const actualIv = iv ?? randomBytes(CRYPTO_CONSTANTS.IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, actualIv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: hexEncode(encrypted),
    iv: hexEncode(actualIv),
    authTag: hexEncode(authTag),
  };
}

// ─── Secret Key Management ──────────────────────────────────────

/**
 * Wrap (encrypt) the secret key with the wrapping key.
 */
export function wrapSecretKey(
  secretKey: Buffer,
  wrappingKey: Buffer
): EncryptedData {
  return aesGcmEncrypt(wrappingKey, secretKey);
}

// ─── Auth Hash ──────────────────────────────────────────────────

/**
 * SHA-256(authKey) → hex
 */
export function computeAuthHash(authKey: Buffer): string {
  return createHash("sha256").update(authKey).digest("hex");
}

// ─── Verifier ───────────────────────────────────────────────────

/**
 * verifierSalt = SHA-256("verifier" || accountSalt)
 */
export function deriveVerifierSalt(accountSalt: Buffer): Buffer {
  const prefix = Buffer.from(CRYPTO_CONSTANTS.VERIFIER_DOMAIN_PREFIX, "utf-8");
  const combined = Buffer.concat([prefix, accountSalt]);
  return createHash("sha256").update(combined).digest();
}

/**
 * PBKDF2(passphrase, verifierSalt, 600k) → SHA-256 → hex
 */
export function computeVerifierHash(
  passphrase: string,
  accountSalt: Buffer
): string {
  const verifierSalt = deriveVerifierSalt(accountSalt);
  const verifierKey = pbkdf2Sync(
    passphrase,
    verifierSalt,
    CRYPTO_CONSTANTS.VERIFIER_PBKDF2_ITERATIONS,
    CRYPTO_CONSTANTS.VERIFIER_PBKDF2_BITS / 8,
    "sha256"
  );
  return createHash("sha256").update(verifierKey).digest("hex");
}

// ─── Verification Artifact ──────────────────────────────────────

/**
 * Encrypt the known verification plaintext with the encryption key.
 */
export function createVerificationArtifact(encKey: Buffer): EncryptedData {
  const plaintext = Buffer.from(
    CRYPTO_CONSTANTS.VERIFICATION_PLAINTEXT,
    "utf-8"
  );
  return aesGcmEncrypt(encKey, plaintext);
}

// ─── HMAC (server-side verifier storage) ────────────────────────

/**
 * Replicate the server's HMAC(pepper, verifierHash) computation.
 */
export function computeVerifierHmac(
  pepper: string,
  verifierHash: string
): string {
  return createHmac("sha256", Buffer.from(pepper, "hex"))
    .update(verifierHash)
    .digest("hex");
}

// ─── Full Vault Setup (convenience) ─────────────────────────────

export interface VaultSetupData {
  accountSalt: string; // hex
  secretKey: Buffer;
  encryptedSecretKey: string; // hex
  secretKeyIv: string; // hex
  secretKeyAuthTag: string; // hex
  authHash: string; // hex
  verifierHash: string; // hex
  verifierHmac: string; // hex
  verificationArtifact: EncryptedData;
  encryptionKey: Buffer;
}

/**
 * Perform the full vault setup crypto chain for a test user.
 * Returns all fields needed to seed the User and VaultKey tables.
 */
export function setupVaultCrypto(
  passphrase: string,
  pepperHex: string
): VaultSetupData {
  const accountSalt = randomBytes(32);
  const secretKey = randomBytes(32);

  // Derive keys
  const wrappingKey = deriveWrappingKey(passphrase, accountSalt);
  const encryptionKey = deriveEncryptionKey(secretKey);
  const authKey = deriveAuthKey(secretKey);

  // Wrap secret key
  const wrapped = wrapSecretKey(secretKey, wrappingKey);

  // Auth hash for server
  const authHash = computeAuthHash(authKey);

  // Verifier
  const verifierHash = computeVerifierHash(passphrase, accountSalt);
  const verifierHmac = computeVerifierHmac(pepperHex, verifierHash);

  // Verification artifact
  const verificationArtifact = createVerificationArtifact(encryptionKey);

  return {
    accountSalt: hexEncode(accountSalt),
    secretKey,
    encryptedSecretKey: wrapped.ciphertext,
    secretKeyIv: wrapped.iv,
    secretKeyAuthTag: wrapped.authTag,
    authHash,
    verifierHash,
    verifierHmac,
    verificationArtifact,
    encryptionKey,
  };
}
