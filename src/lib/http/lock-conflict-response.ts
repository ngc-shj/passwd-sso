import type { NextResponse } from "next/server";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, teamBusy } from "@/lib/http/api-response";
import { isTeamLockTimeout } from "@/lib/team/team-key-rotation-lock";

/**
 * The response for an error `isMembershipLockConflict` (or
 * `isTeamRotationConflict`) accepted: a team-row wait that ran out answers
 * TEAM_BUSY with Retry-After; every other conflict (a tenant-row wait, a team
 * row that could not be locked, a deadlock, an expired transaction) keeps
 * answering CONFLICT. Kept out of the lock modules so they stay free of HTTP
 * types (directory sync and the services import them).
 */
export function membershipConflictResponse(e: unknown): NextResponse {
  return isTeamLockTimeout(e) ? teamBusy() : errorResponse(API_ERROR.CONFLICT);
}
