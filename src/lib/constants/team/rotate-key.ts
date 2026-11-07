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

/**
 * Prisma transaction timeout for one entry's re-key POST: besides the bounded
 * team-lock wait it waits on the entry's history and attachment rows and
 * rewrites up to REKEY_HISTORY_MAX + MAX_ATTACHMENTS_PER_ENTRY of them.
 */
export const TEAM_ENTRY_REKEY_TX_TIMEOUT_MS = 15 * MS_PER_SECOND;

/** Keyset page size of `GET /api/teams/[teamId]/rekey` (default and cap). */
export const REKEY_PAGE_LIMIT_DEFAULT = 50;
export const REKEY_PAGE_LIMIT_MAX = 100;

/** Re-keyer holders listed per team key version in the pass's state report. */
export const REKEY_HOLDERS_LISTED_MAX = 10;

/**
 * State of a pending entry for the caller of the re-key pass (plan C1), by the
 * holders of the entry's team key version.
 */
export const REKEY_ENTRY_STATE = {
  /** The caller holds the version: the caller's pass can re-key it. */
  READY: "ready",
  /** The caller does not; another holder whose role can re-key does. */
  NEEDS_REKEYER_HOLDER: "needs_rekeyer_holder",
  /** Only holders whose role cannot re-key (no TEAM_UPDATE) hold it. */
  HOLDER_CANNOT_REKEY: "holder_cannot_rekey",
  /** No active member holds it. */
  UNRECOVERABLE: "unrecoverable",
} as const;

export type RekeyEntryState = (typeof REKEY_ENTRY_STATE)[keyof typeof REKEY_ENTRY_STATE];
