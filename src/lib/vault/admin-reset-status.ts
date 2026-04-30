// Derives the user-visible status of an AdminVaultReset row from its
// timestamp columns. Precedence (highest to lowest):
//   executed > revoked > expired > approved > pending_approval

export type ResetStatus =
  | "pending_approval"
  | "approved"
  | "executed"
  | "revoked"
  | "expired";

export const STATUS_KEY_MAP: Record<ResetStatus, string> = {
  pending_approval: "statusPendingApproval",
  approved: "statusApproved",
  executed: "statusExecuted",
  revoked: "statusRevoked",
  expired: "statusExpired",
};

export function deriveResetStatus(
  r: {
    approvedAt: Date | null;
    executedAt: Date | null;
    revokedAt: Date | null;
    expiresAt: Date;
  },
  now: Date = new Date(),
): ResetStatus {
  if (r.executedAt !== null) return "executed";
  if (r.revokedAt !== null) return "revoked";
  if (r.expiresAt.getTime() <= now.getTime()) return "expired";
  if (r.approvedAt !== null) return "approved";
  return "pending_approval";
}
