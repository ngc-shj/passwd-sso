import type { PrismaClient, Prisma } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { STALE_ELIGIBLE_STATUSES } from "@/lib/emergency-access/emergency-access-state";
import { EA_STATUS } from "@/lib/constants";

type TxOrPrisma = PrismaClient | Prisma.TransactionClient;

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
  const result = await tx.emergencyAccessGrant.updateMany({
    where: {
      ownerId,
      status: { in: STALE_ELIGIBLE_STATUSES },
      // Only mark stale if the grant's keyVersion is behind the new version
      OR: [
        { keyVersion: { lt: newKeyVersion } },
        { keyVersion: null },
      ],
    },
    data: {
      status: EA_STATUS.STALE,
      ownerEphemeralPublicKey: null,
    },
  });
  return result.count;
}
