/** Milliseconds per second. */
export const MS_PER_SECOND = 1_000;

/** Milliseconds per minute. */
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;

/** Milliseconds per hour. */
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/** Milliseconds per day. */
export const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Post-approval execution TTL. Short window mitigates email-channel disclosure
 * (S3 — once approved, the URL+token sits in the target's mailbox). Capped
 * against the original 24h reset lifetime in the approve handler — see
 * deriveResetExpiresAtAfterApproval(). Defense-in-depth, not standalone defense.
 */
export const EXECUTE_TTL_MS = 60 * MS_PER_MINUTE;

/** Total reset lifetime from initiate to expiry (24h). */
export const RESET_TOTAL_TTL_MS = MS_PER_DAY;

/**
 * A04-4: total master-key rotation lifetime from initiate to expiry (24h).
 * Distinct from RESET_TOTAL_TTL_MS so the two flows can diverge without
 * coupling — same envelope today, decoupled name. Approve narrows expiresAt
 * to min(originalExpiresAt, now + EXECUTE_TTL_MS).
 */
export const ROTATION_TOTAL_TTL_MS = MS_PER_DAY;
