// At-rest encryption for OAuth provider tokens stored in the `accounts` table
// (`refresh_token`, `access_token`, `id_token`). Uses the existing
// `share-master` key from the KeyProvider so we inherit version-rotation
// support without a separate KMS entry.
//
// Storage format:
//   `psoenc1:<keyVersion>:<base64url(iv || authTag || ciphertext)>`
//
// Legacy plaintext rows (rows that pre-date this encryption) are detected by
// the absence of the `psoenc1:` sentinel and returned verbatim by
// `decryptAccountToken`, so the change is backward-compatible at read time.
// The data migration script in `scripts/migrate-account-tokens-to-encrypted.ts`
// rewrites legacy rows to the encrypted form.
//
// AAD binding:
//   AES-256-GCM AAD is set to `<provider>:<providerAccountId>`. This binds the
//   ciphertext to the account row so a stolen ciphertext cannot be swapped
//   between accounts (defense-in-depth — it is not the primary access control,
//   but it prevents an attacker who can write to the DB from substituting
//   another account's encrypted token).

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  getCurrentMasterKeyVersion,
  getMasterKeyByVersion,
} from "@/lib/crypto/crypto-server";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SENTINEL = "psoenc1:";

export type AccountTokenAad = {
  provider: string;
  providerAccountId: string;
};

function buildAad(aad: AccountTokenAad): Buffer {
  return Buffer.from(`${aad.provider}:${aad.providerAccountId}`, "utf8");
}

export function isEncryptedAccountToken(stored: string): boolean {
  return stored.startsWith(SENTINEL);
}

type ParsedEnvelope = {
  version: number;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
};

function parseEnvelope(stored: string): ParsedEnvelope {
  const rest = stored.slice(SENTINEL.length);
  const colonIdx = rest.indexOf(":");
  if (colonIdx <= 0) {
    throw new Error("Malformed encrypted account token: missing version delimiter");
  }
  const versionStr = rest.slice(0, colonIdx);
  const version = Number(versionStr);
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`Malformed encrypted account token: invalid version "${versionStr}"`);
  }
  const blob = Buffer.from(rest.slice(colonIdx + 1), "base64url");
  if (blob.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error("Malformed encrypted account token: blob too short");
  }
  return {
    version,
    iv: blob.subarray(0, IV_LENGTH),
    tag: blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH),
    ciphertext: blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH),
  };
}

function encryptWithKey(
  plaintext: string,
  version: number,
  key: Buffer,
  aad: AccountTokenAad,
): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(buildAad(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, tag, ciphertext]).toString("base64url");
  return `${SENTINEL}${version}:${blob}`;
}

function decryptWithKey(
  envelope: ParsedEnvelope,
  key: Buffer,
  aad: AccountTokenAad,
): string {
  const decipher = createDecipheriv(ALGORITHM, key, envelope.iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAAD(buildAad(aad));
  decipher.setAuthTag(envelope.tag);
  return Buffer.concat([
    decipher.update(envelope.ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

export function encryptAccountToken(
  plaintext: string,
  aad: AccountTokenAad,
): string {
  const version = getCurrentMasterKeyVersion();
  return encryptWithKey(plaintext, version, getMasterKeyByVersion(version), aad);
}

export function decryptAccountToken(
  stored: string | null | undefined,
  aad: AccountTokenAad,
): string | null {
  if (stored == null) return null;
  if (!isEncryptedAccountToken(stored)) {
    // Legacy plaintext row — pass through. Keeps the adapter
    // backward-compatible until the data migration completes.
    return stored;
  }
  const env = parseEnvelope(stored);
  return decryptWithKey(env, getMasterKeyByVersion(env.version), aad);
}

// Convenience helpers for the three optional Auth.js token fields. Each
// returns null if the input is null/undefined and forwards otherwise. These
// are the shapes the auth-adapter needs at write/read time.

export type AccountTokenTriple = {
  refresh_token: string | null | undefined;
  access_token: string | null | undefined;
  id_token: string | null | undefined;
};

const TRIPLE_FIELDS = ["refresh_token", "access_token", "id_token"] as const;

type EncryptedTriple = {
  refresh_token: string | null;
  access_token: string | null;
  id_token: string | null;
};

export function encryptAccountTokenTriple(
  tokens: AccountTokenTriple,
  aad: AccountTokenAad,
): EncryptedTriple {
  // Lazily fetch the current key once and reuse across all present fields.
  let cached: { version: number; key: Buffer } | null = null;
  const out: EncryptedTriple = {
    refresh_token: null,
    access_token: null,
    id_token: null,
  };
  for (const field of TRIPLE_FIELDS) {
    const value = tokens[field];
    if (value == null) continue;
    if (cached == null) {
      const version = getCurrentMasterKeyVersion();
      cached = { version, key: getMasterKeyByVersion(version) };
    }
    out[field] = encryptWithKey(value, cached.version, cached.key, aad);
  }
  return out;
}

export type DecryptTripleOptions = {
  // Per-field error handler. When provided, an error decrypting one field
  // does NOT abort the other fields — the failed field is left as null and
  // the handler is invoked with the field name and the error. When omitted,
  // the first error propagates (matching `decryptAccountToken`).
  onFieldError?: (
    field: (typeof TRIPLE_FIELDS)[number],
    err: unknown,
  ) => void;
};

export function decryptAccountTokenTriple(
  stored: AccountTokenTriple,
  aad: AccountTokenAad,
  options?: DecryptTripleOptions,
): EncryptedTriple {
  // Cache keys per version so a triple encrypted under a single version (the
  // common case) only fetches the master key once.
  const keyCache = new Map<number, Buffer>();
  const out: EncryptedTriple = {
    refresh_token: null,
    access_token: null,
    id_token: null,
  };
  for (const field of TRIPLE_FIELDS) {
    const value = stored[field];
    if (value == null) continue;
    if (!isEncryptedAccountToken(value)) {
      out[field] = value;
      continue;
    }
    try {
      const env = parseEnvelope(value);
      let key = keyCache.get(env.version);
      if (!key) {
        key = getMasterKeyByVersion(env.version);
        keyCache.set(env.version, key);
      }
      out[field] = decryptWithKey(env, key, aad);
    } catch (err) {
      if (options?.onFieldError) {
        options.onFieldError(field, err);
      } else {
        throw err;
      }
    }
  }
  return out;
}
