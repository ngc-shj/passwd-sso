/**
 * Reading a refusal of the database's departed-member guard
 * (`departed_member_guard()`, migration 20261117000000).
 *
 * The guard raises `check_violation` with a message that starts
 * `DEPARTED_MEMBER_GUARD:<arm>:`. The arm token is the guard's own text, so
 * unlike a PostgreSQL message it is not localised. The adapter keeps no
 * structured field for it, so the message is the channel, read at the same
 * nestings `pgConstraintName` reads (src/lib/prisma/prisma-error.ts).
 */

import { pgErrorCode, SQLSTATE_CHECK_VIOLATION } from "@/lib/prisma/prisma-error";

const GUARD_ARM_RE = /\bDEPARTED_MEMBER_GUARD:([a-z_]+):/;

/** The guard's arm token when `err` is its refusal, otherwise null. */
export function departedMemberGuardArm(err: unknown): string | null {
  if (pgErrorCode(err) !== SQLSTATE_CHECK_VIOLATION) return null;

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
    const arm = GUARD_ARM_RE.exec(candidate)?.[1];
    if (arm) return arm;
  }
  return null;
}
