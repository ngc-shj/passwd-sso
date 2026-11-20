import { SQLSTATE_CHECK_VIOLATION } from "@/lib/prisma/prisma-error";

const ZERO_UUID = "00000000-0000-4000-8000-000000000000";

/**
 * A database guard's refusal in the shape the pg driver adapter surfaces it:
 * the SQLSTATE and the guard's message nested under meta.driverAdapterError.cause,
 * with a generic Prisma invocation message on the outer error.
 */
export function databaseGuardError(guardName: string, arm: string): Error {
  return Object.assign(new Error("Invalid `prisma.teamMemberKey.upsert()` invocation"), {
    code: "P2010",
    meta: {
      driverAdapterError: {
        cause: {
          originalCode: SQLSTATE_CHECK_VIOLATION,
          originalMessage: `${guardName}:${arm}: team_member_keys (team ${ZERO_UUID}, user ${ZERO_UUID})`,
        },
      },
    },
  });
}

export const teamKeyRecipientGuardError = (arm: string) => databaseGuardError("TEAM_KEY_RECIPIENT_GUARD", arm);
