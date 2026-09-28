import { createHash, timingSafeEqual } from "crypto";

/**
 * Compare a client-presented authHash against the user's stored server hash.
 *
 * Verification: SHA-256(authHash + serverSalt) === stored serverHash, compared
 * with a constant-time equality check. A length mismatch (malformed/legacy
 * stored hash) returns false rather than throwing or comparing unequal-length
 * buffers.
 *
 * Pure — callers own lockout and rate-limit policy. Single compare
 * implementation for every authHash verification site (R48): `/api/vault/unlock`
 * (lockout + per-user limiter), `/api/vault/rotate-key` (current-passphrase
 * check, route limiter only), and `/api/vault/unlock/verify` (per-family
 * limiter, no lockout — see plan C1/C2).
 */
export function compareVaultAuthHash(
  authHash: string,
  stored: { masterPasswordServerHash: string; masterPasswordServerSalt: string },
): boolean {
  const computedHash = createHash("sha256")
    .update(authHash + stored.masterPasswordServerSalt)
    .digest("hex");

  const hashA = Buffer.from(computedHash, "hex");
  const hashB = Buffer.from(stored.masterPasswordServerHash, "hex");
  return hashA.length === hashB.length && timingSafeEqual(hashA, hashB);
}
