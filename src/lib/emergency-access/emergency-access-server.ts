import { prisma as defaultPrisma, type TxOrPrisma } from "@/lib/prisma";
import { bulkTransition } from "@/lib/emergency-access/emergency-access-state";

/**
 * Mark all escrow-holding grants as STALE when the owner's keyVersion changes.
 *
 * Called from POST /api/vault/rotate-key inside its rotation transaction so
 * the EA invalidation rolls back atomically with the rest of the rotation
 * (#433 / S1+S2 — atomicity > best-effort).
 *
 * In addition to the status flip, this nulls `ownerEphemeralPublicKey`. The
 * grantee's `unwrapSecretKeyAsGrantee()` (crypto-emergency.ts:269-302) requires
 * that field to derive the ECDH shared key, so dropping it defeats unwrap
 * even if the wrapping ciphertext (encryptedSecretKey/Iv/AuthTag/hkdfSalt)
 * remains present for forensic trail (#433 / S2 — minimum-clear).
 *
 * The `keyVersion: null` arm of the OR clause catches grants created before
 * keyVersion tracking was introduced — omitting it would leak pre-keyVersion
 * grants past rotation (F14 / PR #433/S1 regression).
 *
 * @param ownerId        User whose grants are being invalidated.
 * @param newKeyVersion  The new keyVersion the owner is rotating to.
 * @param tx             Optional transaction client. Defaults to `prisma`.
 *                       Pass the rotation transaction's client to make this
 *                       clear part of the same atomic unit.
 */
export async function markGrantsStaleForOwner(
  ownerId: string,
  newKeyVersion: number,
  tx: TxOrPrisma = defaultPrisma,
): Promise<number> {
  // bulkTransition derives the allowed-from set from the matrix internally
  // (for STALE + SYSTEM: [IDLE, REQUESTED, ACTIVATED] — PR #433/S1 invariant).
  // Do NOT add status: { in: ... } here — that would double-narrow and break the matrix SSoT (C1).
  const result = await bulkTransition({
    db: tx,
    where: {
      ownerId,
      // F14: both arms required — lt catches outdated grants; null catches
      // grants predating keyVersion tracking.
      OR: [
        { keyVersion: { lt: newKeyVersion } },
        { keyVersion: null },
      ],
    },
    to: "STALE",
    actor: "SYSTEM",
    // F15: clearing ownerEphemeralPublicKey defeats ECDH unwrap even if
    // the wrapping ciphertext is retained for forensic purposes.
    extraData: { ownerEphemeralPublicKey: null },
  });
  return result.updated;
}
