import type { Prisma } from "@prisma/client";
import { MS_PER_MINUTE } from "@/lib/constants/time";

/**
 * Effective expiry for an issued/rotated client (extension or iOS) token row.
 *
 * The token's lifetime is bounded by whichever cap is soonest:
 *  - `now + idle` — a hard ceiling on any single row's lifetime.
 *  - `presenceAt + idle` — the family goes stale `idle` after the last
 *    server-verified vault unlock, regardless of how often it was refreshed.
 *  - `familyCreatedAt + absolute` — the family's absolute cap.
 *
 * See plan §C3. Every extension/iOS token issuance and refresh site must
 * compute `expiresAt` through this function — `scripts/checks/check-client-token-expiry.mjs`
 * (B2) enforces it lexically.
 */
export function computeClientTokenExpiry(params: {
  now: Date;
  presenceAt: Date;
  familyCreatedAt: Date;
  idleMinutes: number;
  absoluteMinutes: number;
}): Date {
  const { now, presenceAt, familyCreatedAt, idleMinutes, absoluteMinutes } = params;
  const idleFromNow = now.getTime() + idleMinutes * MS_PER_MINUTE;
  const idleFromPresence = presenceAt.getTime() + idleMinutes * MS_PER_MINUTE;
  const absoluteFromFamily = familyCreatedAt.getTime() + absoluteMinutes * MS_PER_MINUTE;
  return new Date(Math.min(idleFromNow, idleFromPresence, absoluteFromFamily));
}

/**
 * Read a token family's presence timestamp: MAX(lastPresenceAt) over EVERY
 * row of the family, including already-revoked ones.
 *
 * Rotation can land a presence write on the row that is about to be (or was
 * just) revoked — filtering by `revokedAt: null` would silently drop that
 * write and let the family go stale early (plan §C4 red-proof: adding such a
 * filter must turn the deterministic-sequence integration test red).
 *
 * Falls back to `familyCreatedAt` when no row in the family has ever recorded
 * presence (fresh family, or a pre-migration family that never called
 * `POST /api/vault/unlock/verify`).
 */
export async function getFamilyPresenceAt(
  tx: Prisma.TransactionClient,
  familyId: string,
  familyCreatedAt: Date,
): Promise<Date> {
  const result = await tx.extensionToken.aggregate({
    where: { familyId },
    _max: { lastPresenceAt: true },
  });
  return result._max.lastPresenceAt ?? familyCreatedAt;
}
