import type { Prisma } from "@prisma/client";
import { prisma as defaultPrisma, type TxOrPrisma } from "@/lib/prisma";
import { bulkTransition } from "@/lib/emergency-access/emergency-access-state";
import { EA_STATUS, EA_ACTOR } from "@/lib/constants";

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
    to: EA_STATUS.STALE,
    actor: EA_ACTOR.SYSTEM,
    // F15: clearing ownerEphemeralPublicKey defeats ECDH unwrap even if
    // the wrapping ciphertext is retained for forensic purposes.
    extraData: { ownerEphemeralPublicKey: null },
  });
  return result.updated;
}

/**
 * The owner's grants that block a new grant to `granteeEmail` (DUPLICATE_GRANT).
 *
 * A never-accepted invite whose token has expired is excluded: it can no longer
 * be accepted, and until the retention sweep removes it, it would otherwise
 * block re-inviting the same person. "Expired" matches the accept routes
 * (`tokenExpiresAt < now` refuses), so an invite they would still honour keeps
 * counting as a duplicate.
 */
export function duplicateGrantWhere(
  ownerId: string,
  granteeEmail: string,
  now: Date,
): Prisma.EmergencyAccessGrantWhereInput {
  return {
    ownerId,
    // `in`, not `equals`: insensitive `equals` is an unescaped ILIKE, so `_` or
    // `%` in the address matched other grants (round-8 R8-S4).
    granteeEmail: { in: [granteeEmail], mode: "insensitive" },
    status: { notIn: [EA_STATUS.REVOKED, EA_STATUS.REJECTED] },
    NOT: { status: EA_STATUS.PENDING, tokenExpiresAt: { lt: now } },
  };
}
