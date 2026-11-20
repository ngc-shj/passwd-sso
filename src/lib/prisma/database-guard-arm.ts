/**
 * Reading a refusal of one of the database's guard triggers
 * (`departed_member_guard()`, `team_key_recipient_guard()`,
 * `users_ecdh_key_guard()`).
 *
 * A guard raises `check_violation` with a message that starts
 * `<GUARD_NAME>:<arm>:`. The arm token is the guard's own text, so unlike a
 * PostgreSQL message it is not localised. The adapter keeps no structured field
 * for it, so the message is the channel, read at the same nestings
 * `pgConstraintName` reads (src/lib/prisma/prisma-error.ts).
 */

import { pgErrorCode, SQLSTATE_CHECK_VIOLATION } from "@/lib/prisma/prisma-error";

/** The guard's arm token when `err` is a refusal of the guard named `guardName`, otherwise null. */
export function databaseGuardArm(err: unknown, guardName: string): string | null {
  if (pgErrorCode(err) !== SQLSTATE_CHECK_VIOLATION) return null;

  const armRe = new RegExp(`\\b${guardName}:([a-z_]+):`);
  const candidates: unknown[] = [];
  const meta = (err as { meta?: unknown }).meta;
  if (meta && typeof meta === "object") {
    const adapter = (meta as { driverAdapterError?: unknown }).driverAdapterError;
    if (adapter && typeof adapter === "object") {
      const cause = (adapter as { cause?: unknown }).cause;
      if (cause && typeof cause === "object") {
        candidates.push(
          (cause as { originalMessage?: unknown }).originalMessage,
          (cause as { message?: unknown }).message,
        );
      }
      candidates.push((adapter as { message?: unknown }).message);
    }
  }
  candidates.push(err instanceof Error ? err.message : undefined);

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const arm = armRe.exec(candidate)?.[1];
    if (arm) return arm;
  }
  return null;
}
