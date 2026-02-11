import { prisma } from "@/lib/prisma";
import { STALE_ELIGIBLE_STATUSES } from "@/lib/emergency-access-state";

/**
 * Mark all escrow-holding grants as STALE when the owner's keyVersion changes.
 * Called from key rotation endpoints.
 */
export async function markGrantsStaleForOwner(ownerId: string, newKeyVersion: number): Promise<number> {
  const result = await prisma.emergencyAccessGrant.updateMany({
    where: {
      ownerId,
      status: { in: STALE_ELIGIBLE_STATUSES },
      // Only mark stale if the grant's keyVersion is behind the new version
      OR: [
        { keyVersion: { lt: newKeyVersion } },
        { keyVersion: null },
      ],
    },
    data: { status: "STALE" },
  });
  return result.count;
}
