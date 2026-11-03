import { MS_PER_MINUTE, MS_PER_SECOND } from "../time";

/** Prisma transaction timeout for team key rotation (1 minute). */
export const TEAM_ROTATE_TX_TIMEOUT_MS = MS_PER_MINUTE;

/**
 * How long a team entry or key write waits for an in-flight rotation of the
 * team before answering 409. Below Prisma's 5s default transaction timeout,
 * so the wait ends as a conflict, not an expired transaction.
 */
export const TEAM_KEY_LOCK_TIMEOUT_MS = 3 * MS_PER_SECOND;

/**
 * Prisma transaction timeout for a transaction that waits on tenant
 * membership rows and team rows (tenant departure, admission): its lock
 * waits share one TEAM_KEY_LOCK_TIMEOUT_MS deadline, and this leaves room for
 * the work after them, so the transaction does not expire first.
 */
export const TEAM_MEMBERSHIP_TX_TIMEOUT_MS = 10 * MS_PER_SECOND;

/**
 * Why a rotation carries an entry unchanged instead of re-wrapping it
 * (team-key-rotation-rekey plan C3). The entry keeps its old team key version
 * and stays pending re-key.
 */
export const ROTATE_CARRY_REASON = {
  /** The rotating member holds no member key at the entry's team key version. */
  NOT_HELD: "not_held",
  /** The entry failed AES-GCM authentication under a key the member holds. */
  UNDECRYPTABLE: "undecryptable",
  /** The member's own member-key row at that version failed to unwrap. */
  KEY_INVALID: "key_invalid",
} as const;

export type RotateCarryReason = (typeof ROTATE_CARRY_REASON)[keyof typeof ROTATE_CARRY_REASON];
