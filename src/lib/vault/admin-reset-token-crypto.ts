// At-rest encryption for the dual-approval admin-vault-reset email-link token.
//
// AAD binding (A02-7):
//   AES-256-GCM AAD is encoded via the shared length-prefixed binary format
//   (buildAADBytes) under scope `AR` with 3 fields. Length-prefixed encoding
//   eliminates the delimiter-collision risk of the previous `tenantId:resetId:
//   email` string form: if a future identifier format introduces ':' the
//   wrong-shape AAD would silently match. Length prefixes make field
//   boundaries unambiguous regardless of field content.
//
//   The binding still locks each ciphertext to:
//     - the specific reset row (resetId) — substitution across rows fails
//     - the target user's email at initiate (targetEmailAtInitiate) — if the
//       target user changes their email after initiate, decryption fails (FR12)
//
// Pre-1.0 wire-format change: pending reset tokens encrypted with the old
// string AAD will not decrypt and must be re-initiated. Reset TTL is short
// (hours) so the impact window is bounded.
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
import { buildAADBytes } from "@/lib/crypto/crypto-aad";

const SCOPE_ADMIN_RESET = "AR";

export type AdminResetAad = {
  tenantId: string;
  resetId: string;
  targetEmailAtInitiate: string;
};

function buildAad(aad: AdminResetAad): Buffer {
  return Buffer.from(
    buildAADBytes(SCOPE_ADMIN_RESET, 3, [
      aad.tenantId,
      aad.resetId,
      aad.targetEmailAtInitiate,
    ]),
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
