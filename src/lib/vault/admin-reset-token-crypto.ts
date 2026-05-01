// At-rest encryption for the dual-approval admin-vault-reset email-link token.
//
// AAD binding:
//   AES-256-GCM AAD is set to `<tenantId>:<resetId>:<targetEmailAtInitiate>`.
//   This binds the ciphertext to the specific reset row + target user's email
//   at initiate time so:
//     - A stolen ciphertext cannot be substituted into a different reset row.
//     - An admin who initiated the reset cannot continue to use the email-link
//       token if the target user changed their email between initiate and
//       approve (FR12).
//
//   AAD bytes are opaque to AES-GCM — never re-parsed. Email may contain ':'
//   per RFC 5322 §3.4.1 quoted-local-part; this is fine because we never split
//   the AAD back, only compare bytes for equality during decryption.
//
// Storage format:
//   `psoenc1:<keyVersion>:<base64url(iv || authTag || ciphertext)>`
//   (shared envelope format with `account-token-crypto.ts`; cross-subsystem
//   substitution is prevented by distinct AAD shapes per caller — see
//   `src/lib/crypto/envelope.ts` header.)

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

export type AdminResetAad = {
  tenantId: string;
  resetId: string;
  targetEmailAtInitiate: string;
};

function buildAad(aad: AdminResetAad): Buffer {
  return Buffer.from(
    `${aad.tenantId}:${aad.resetId}:${aad.targetEmailAtInitiate}`,
    "utf8",
  );
}

export function encryptResetToken(plaintext: string, aad: AdminResetAad): string {
  const version = getCurrentMasterKeyVersion();
  return encryptWithKey(plaintext, version, getMasterKeyByVersion(version), buildAad(aad));
}

export function decryptResetToken(
  stored: string | null | undefined,
  aad: AdminResetAad,
): string | null {
  if (stored == null) return null;
  if (!isEncryptedEnvelope(stored)) {
    // Reset tokens are always written in the encrypted envelope form — there
    // is no legacy-plaintext path. Treat anything else as malformed.
    throw new Error("Malformed encrypted account token: missing sentinel");
  }
  const env = parseEnvelope(stored);
  return decryptWithKey(env, getMasterKeyByVersion(env.version), buildAad(aad));
}
