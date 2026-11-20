/**
 * Reading a refusal of the database's departed-member guard
 * (`departed_member_guard()`, migration 20261117000100).
 */

import { databaseGuardArm } from "@/lib/prisma/database-guard-arm";

/** The guard's arm token when `err` is its refusal, otherwise null. */
export function departedMemberGuardArm(err: unknown): string | null {
  return databaseGuardArm(err, "DEPARTED_MEMBER_GUARD");
}
