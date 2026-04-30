// Derives the user-visible status of an AdminVaultReset row from its
// timestamp columns. Precedence (highest to lowest):
//   executed > revoked > expired > approved > pending_approval

export const RESET_STATUS = {
  PENDING_APPROVAL: "pending_approval",
  APPROVED: "approved",
  EXECUTED: "executed",
  REVOKED: "revoked",
  EXPIRED: "expired",
} as const;

export type ResetStatus = (typeof RESET_STATUS)[keyof typeof RESET_STATUS];

// `as const satisfies ...` keeps the map values as literal types so callers
// can index it without an `as` cast and consumers can derive the i18n-key
// union directly via `(typeof STATUS_KEY_MAP)[ResetStatus]`.
export const STATUS_KEY_MAP = {
  [RESET_STATUS.PENDING_APPROVAL]: "statusPendingApproval",
  [RESET_STATUS.APPROVED]: "statusApproved",
  [RESET_STATUS.EXECUTED]: "statusExecuted",
  [RESET_STATUS.REVOKED]: "statusRevoked",
  [RESET_STATUS.EXPIRED]: "statusExpired",
} as const satisfies Record<ResetStatus, string>;

export type StatusI18nKey = (typeof STATUS_KEY_MAP)[ResetStatus];

export function deriveResetStatus(
  r: {
    approvedAt: Date | null;
    executedAt: Date | null;
    revokedAt: Date | null;
    expiresAt: Date;
  },
  now: Date = new Date(),
): ResetStatus {
  if (r.executedAt !== null) return RESET_STATUS.EXECUTED;
  if (r.revokedAt !== null) return RESET_STATUS.REVOKED;
  if (r.expiresAt.getTime() <= now.getTime()) return RESET_STATUS.EXPIRED;
  if (r.approvedAt !== null) return RESET_STATUS.APPROVED;
  return RESET_STATUS.PENDING_APPROVAL;
}
