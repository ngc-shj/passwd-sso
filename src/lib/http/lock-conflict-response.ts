import type { NextResponse } from "next/server";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, handleAuthError, teamBusy, unauthorized } from "@/lib/http/api-response";
import { TenantAuthError } from "@/lib/auth/access/tenant-auth";
import { UserAuthRevokedError } from "@/lib/auth/session/user-auth-serialization";
import { isTeamLockTimeout } from "@/lib/team/team-key-rotation-lock";
import { isMembershipLockConflict } from "@/lib/team/tenant-row-lock";

/**
 * The response for an error `isMembershipLockConflict` (or
 * `isTeamRotationConflict`) accepted: a team-row wait that ran out answers
 * TEAM_BUSY with Retry-After; every other conflict (a tenant-row wait, a team
 * row that could not be locked, a wait on the user's credential lock
 * (UserAuthLockTimeoutError), a deadlock, an expired transaction) keeps
 * answering CONFLICT. Kept out of the lock modules so they stay free of HTTP
 * types (directory sync and the services import them).
 */
export function membershipConflictResponse(e: unknown): NextResponse {
  return isTeamLockTimeout(e) ? teamBusy() : errorResponse(API_ERROR.CONFLICT);
}

/**
 * The catch-arm answer for a transaction that opened with lockFootholdWriter:
 * a refused actor (TenantAuthError), a revoked session (UserAuthRevokedError)
 * or a lock conflict. Null for any other error, which the caller handles or
 * rethrows. Run it before the route's own constraint (P2002) handling.
 */
export function footholdWriteErrorResponse(e: unknown): NextResponse | null {
  if (e instanceof TenantAuthError) return handleAuthError(e);
  if (e instanceof UserAuthRevokedError) return unauthorized();
  if (isMembershipLockConflict(e)) return membershipConflictResponse(e);
  return null;
}
