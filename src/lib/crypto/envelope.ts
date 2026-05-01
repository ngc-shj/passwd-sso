// AAD-agnostic envelope helper for the `psoenc1:` versioned ciphertext format.
//
// Each caller is responsible for building its own AAD bytes
// (e.g., `src/lib/crypto/account-token-crypto.ts` and
// `src/lib/vault/admin-reset-token-crypto.ts`). Cross-subsystem ciphertext
// substitution is prevented by per-caller AAD shapes — domain-prefix is
// intentionally NOT applied here because changing AAD bytes for an existing
// caller would break decryption of already-stored ciphertexts.
//
// Storage format:
//   `psoenc1:<keyVersion>:<base64url(iv || authTag || ciphertext)>`

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const ALGORITHM = "aes-256-gcm";
export const IV_LENGTH = 12;
export const AUTH_TAG_LENGTH = 16;
export const SENTINEL = "psoenc1:";

export type ParsedEnvelope = {
  version: number;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
};

export function isEncryptedEnvelope(stored: string): boolean {
  return stored.startsWith(SENTINEL);
}

export function parseEnvelope(stored: string): ParsedEnvelope {
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

export function encryptWithKey(
  plaintext: string,
  version: number,
  key: Buffer,
  aad: Buffer,
): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, tag, ciphertext]).toString("base64url");
  return `${SENTINEL}${version}:${blob}`;
}

export function decryptWithKey(
  envelope: ParsedEnvelope,
  key: Buffer,
  aad: Buffer,
): string {
  const decipher = createDecipheriv(ALGORITHM, key, envelope.iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(envelope.tag);
  return Buffer.concat([
    decipher.update(envelope.ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
