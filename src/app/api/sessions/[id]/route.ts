import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { withRequestLog } from "@/lib/http/with-request-log";
import { getSessionTokenDigest } from "../helpers";
import { withUserTenantRls } from "@/lib/tenant-context";
import { errorResponse, rateLimited, unauthorized } from "@/lib/http/api-response";
import { invalidateCachedSessions } from "@/lib/auth/session/session-cache-helpers";
import { RATE_WINDOW_MS } from "@/lib/validations/common.server";

const revokeLimiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: 10 });

async function handleDELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const rl = await revokeLimiter.check(`rl:session_revoke:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const { id } = await params;

  // Check if the target session is the current one. H4: the DB column stores
  // the digest, so compare against the digest of the current cookie token —
  // comparing against the raw token would never match and let a user revoke
  // their own current session.
  const currentTokenDigest = getSessionTokenDigest(request);
  if (!currentTokenDigest) {
    return unauthorized();
  }

  const target = await withUserTenantRls(session.user.id, async () =>
    prisma.session.findFirst({
      where: { id, userId: session.user.id },
      select: { sessionToken: true },
    }),
  );
  if (target?.sessionToken === currentTokenDigest) {
    return errorResponse(API_ERROR.CANNOT_REVOKE_CURRENT_SESSION);
  }

  // Delete with userId condition to prevent deleting other users' sessions
  const result = await withUserTenantRls(session.user.id, async () =>
    prisma.session.deleteMany({
      where: { id, userId: session.user.id },
    }),
  );

  if (result.count === 0) {
    return errorResponse(API_ERROR.SESSION_NOT_FOUND);
  }

  // R3: invalidate cache after DB delete commits (S-6 sequencing).
  if (target?.sessionToken) {
    await invalidateCachedSessions([target.sessionToken]);
  }

  await logAuditAsync({
    ...personalAuditBase(request, session.user.id),
    action: AUDIT_ACTION.SESSION_REVOKE,
    targetType: AUDIT_TARGET_TYPE.SESSION,
    targetId: id,
  });

  return NextResponse.json({ success: true });
}

export const DELETE = withRequestLog(handleDELETE);
