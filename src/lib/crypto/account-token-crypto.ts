// At-rest encryption for OAuth provider tokens stored in the `accounts` table
// (`refresh_token`, `access_token`, `id_token`). Uses the existing
// `share-master` key from the KeyProvider so we inherit version-rotation
// support without a separate KMS entry.
//
// Storage format:
//   `psoenc1:<keyVersion>:<base64url(iv || authTag || ciphertext)>`
//
// AAD binding:
//   AES-256-GCM AAD is the binary length-prefixed format (scope "AC", 3 fields:
//   userId, provider, providerAccountId) from the single registry in
//   crypto-aad.ts. The binary format eliminates delimiter-collision risk, so
//   provider values may now contain ":".
//
//   The envelope ops (parse / encrypt / decrypt) live in
//   `src/lib/crypto/envelope.ts`.
//
// No plaintext fallback:
//   Stored values without the `psoenc1:` sentinel are treated as CORRUPT
//   (decrypt throws, classified as CORRUPT in `decryptAccountTokenTriple`).
//   A previous version of this module returned plaintext verbatim for
//   backward-compatibility with pre-encryption rows; that fallback was
//   removed because a DB-write attacker could write any plaintext value to
//   bypass the AAD bind entirely. The migration script
//   `scripts/migrate-account-tokens-to-encrypted.ts` reads raw SQL and uses
//   `encryptAccountToken` directly, so it is not affected by this removal.
//
//   NOTE: the project is in pre-production / dev phase. Existing dev rows
//   encrypted under the prior AAD shape will fail decryption on next read →
//   the user re-OAuths and the row is rewritten under the new AAD. Once
//   production users exist, any further AAD shape change requires a
//   re-encryption migration script.

import {
  encryptWithKey,
  decryptWithKey,
  parseEnvelope,
  isEncryptedEnvelope,
} from "@/lib/crypto/envelope";
import {
  getCurrentMasterKeyVersion,
  getMasterKeyByVersion,
} from "@/lib/crypto/crypto-server";
import { buildAccountTokenAAD, type AccountTokenAad } from "@/lib/crypto/crypto-aad";

// Re-export so callers importing AccountTokenAad from this module stay unchanged.
export type { AccountTokenAad };

function buildAad(aad: AccountTokenAad): Buffer {
  return Buffer.from(buildAccountTokenAAD(aad));
}

export function isEncryptedAccountToken(stored: string): boolean {
  return isEncryptedEnvelope(stored);
}

export function encryptAccountToken(
  plaintext: string,
  aad: AccountTokenAad,
): string {
  const version = getCurrentMasterKeyVersion();
  return encryptWithKey(plaintext, version, getMasterKeyByVersion(version), buildAad(aad));
}

export function decryptAccountToken(
  stored: string | null | undefined,
  aad: AccountTokenAad,
): string | null {
  if (stored == null) return null;
  // No plaintext fallback — any non-sentinel value falls through to
  // `parseEnvelope` and throws. See module header for rationale.
  const env = parseEnvelope(stored);
  return decryptWithKey(env, getMasterKeyByVersion(env.version), buildAad(aad));
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
  const aadBytes = buildAad(aad);
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
    out[field] = encryptWithKey(value, cached.version, cached.key, aadBytes);
  }
  return out;
}

// Failure mode classification. The single adversarial signal is `TAMPERED`
// — an AES-GCM auth-tag failure given a structurally valid envelope and a
// loadable key, which means the AAD or the ciphertext was altered after
// encryption. The other two are operational/benign and should NOT be elevated
// to security audit events.
export const DECRYPT_FAILURE_KIND = {
  CORRUPT: "CORRUPT",                 // envelope parse or shape error
  KEY_UNAVAILABLE: "KEY_UNAVAILABLE", // master key for the recorded version not loaded
  TAMPERED: "TAMPERED",               // GCM auth-tag failure — AAD/ciphertext mismatch
} as const;
export type DecryptFailureKind =
  (typeof DECRYPT_FAILURE_KIND)[keyof typeof DECRYPT_FAILURE_KIND];

export type DecryptTripleOptions = {
  // Per-field error handler. When provided, an error decrypting one field
  // does NOT abort the other fields — the failed field is left as null and
  // the handler is invoked with the field name, the error, and a classified
  // `kind` so callers can route security-relevant TAMPERED failures
  // separately from benign CORRUPT/KEY_UNAVAILABLE failures. When omitted,
  // the first error propagates (matching `decryptAccountToken`).
  onFieldError?: (
    field: (typeof TRIPLE_FIELDS)[number],
    err: unknown,
    kind: DecryptFailureKind,
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
  const aadBytes = buildAad(aad);
  const out: EncryptedTriple = {
    refresh_token: null,
    access_token: null,
    id_token: null,
  };
  for (const field of TRIPLE_FIELDS) {
    const value = stored[field];
    if (value == null) continue;
    // No plaintext fallback — any non-sentinel value is classified CORRUPT
    // (envelope parse fails). See module header for rationale.
    let kind: DecryptFailureKind = DECRYPT_FAILURE_KIND.CORRUPT;
    try {
      const env = parseEnvelope(value);
      let key = keyCache.get(env.version);
      if (!key) {
        kind = DECRYPT_FAILURE_KIND.KEY_UNAVAILABLE;
        key = getMasterKeyByVersion(env.version);
        keyCache.set(env.version, key);
      }
      kind = DECRYPT_FAILURE_KIND.TAMPERED;
      out[field] = decryptWithKey(env, key, aadBytes);
    } catch (err) {
      if (options?.onFieldError) {
        options.onFieldError(field, err, kind);
      } else {
        throw err;
      }
    }
  }
  return out;
}
