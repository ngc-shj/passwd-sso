/**
 * Reading a refusal of the database's team-key recipient guards
 * (`team_key_recipient_guard()` on team_member_keys and
 * `users_ecdh_key_guard()` on users, migration 20261119000000).
 */

import { databaseGuardArm } from "@/lib/prisma/database-guard-arm";

export const TEAM_KEY_RECIPIENT_GUARD_ARM = {
  /** A key row written without the fingerprint of the key it was wrapped to. */
  FINGERPRINT_MISSING: "fingerprint_missing",
  /** A fingerprint changed on a row whose wrap was not rewritten. */
  FINGERPRINT_REBIND: "fingerprint_rebind",
  /** The recipient has no ECDH public key (vault reset). */
  RECIPIENT_NO_KEY: "recipient_no_key",
  /** The recipient's current key is not the one the client wrapped to. */
  RECIPIENT_KEY_CHANGED: "recipient_key_changed",
  /** A non-NULL ECDH public key overwritten by another (a racing vault setup). */
  ECDH_KEY_OVERWRITE: "ecdh_key_overwrite",
  /** A key retired while the user still holds a key row or a distributed flag. */
  ECDH_KEY_CHANGE_WITH_KEYS: "ecdh_key_change_with_keys",
} as const;

/** The arm token when `err` is a refusal of either recipient guard, otherwise null. */
export function teamKeyRecipientGuardArm(err: unknown): string | null {
  return databaseGuardArm(err, "TEAM_KEY_RECIPIENT_GUARD");
}

/**
 * The recipient's key is not (or no longer) the one the client wrapped to: the
 * client should refetch the key and wrap again. The other arms are unreachable
 * through the request schemas and are left to propagate.
 */
export function isTeamKeyRecipientChanged(err: unknown): boolean {
  const arm = teamKeyRecipientGuardArm(err);
  return (
    arm === TEAM_KEY_RECIPIENT_GUARD_ARM.RECIPIENT_KEY_CHANGED ||
    arm === TEAM_KEY_RECIPIENT_GUARD_ARM.RECIPIENT_NO_KEY
  );
}
