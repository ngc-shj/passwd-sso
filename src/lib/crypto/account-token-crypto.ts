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

export function encryptAccountToken(
  plaintext: string,
  aad: AccountTokenAad,
): string {
  const version = getCurrentMasterKeyVersion();
  const key = getMasterKeyByVersion(version);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  cipher.setAAD(buildAad(aad));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, tag, ciphertext]).toString("base64url");
  return `${SENTINEL}${version}:${blob}`;
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
  const rest = stored.slice(SENTINEL.length);
  const colonIdx = rest.indexOf(":");
  if (colonIdx <= 0) {
    throw new Error("Malformed encrypted account token: missing version delimiter");
  }
  const versionStr = rest.slice(0, colonIdx);
  const blobB64 = rest.slice(colonIdx + 1);
  const version = Number(versionStr);
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`Malformed encrypted account token: invalid version "${versionStr}"`);
  }
  const blob = Buffer.from(blobB64, "base64url");
  if (blob.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error("Malformed encrypted account token: blob too short");
  }
  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const key = getMasterKeyByVersion(version);
  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAAD(buildAad(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8",
  );
}

// Convenience helpers for the three optional Auth.js token fields. Each
// returns null if the input is null/undefined and forwards otherwise. These
// are the shapes the auth-adapter needs at write/read time.

export type AccountTokenTriple = {
  refresh_token: string | null | undefined;
  access_token: string | null | undefined;
  id_token: string | null | undefined;
};

export function encryptAccountTokenTriple(
  tokens: AccountTokenTriple,
  aad: AccountTokenAad,
): {
  refresh_token: string | null;
  access_token: string | null;
  id_token: string | null;
} {
  return {
    refresh_token:
      tokens.refresh_token == null ? null : encryptAccountToken(tokens.refresh_token, aad),
    access_token:
      tokens.access_token == null ? null : encryptAccountToken(tokens.access_token, aad),
    id_token:
      tokens.id_token == null ? null : encryptAccountToken(tokens.id_token, aad),
  };
}

export function decryptAccountTokenTriple(
  stored: AccountTokenTriple,
  aad: AccountTokenAad,
): {
  refresh_token: string | null;
  access_token: string | null;
  id_token: string | null;
} {
  return {
    refresh_token: decryptAccountToken(stored.refresh_token, aad),
    access_token: decryptAccountToken(stored.access_token, aad),
    id_token: decryptAccountToken(stored.id_token, aad),
  };
}
