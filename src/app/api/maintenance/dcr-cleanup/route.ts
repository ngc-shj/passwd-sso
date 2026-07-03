/**
 * POST /api/maintenance/dcr-cleanup
 *
 * DEPRECATED — returns 410 Gone for one minor version.
 *
 * DCR cleanup is now automatic: the generic `retention-gc-worker` process runs
 * periodic sweeps (DCR clients are one entry in its retention registry) and emits
 * SYSTEM-attributed audit events. This endpoint stub authenticates the caller so that
 * stale cron jobs are surfaced via a MCP_CLIENT_DCR_CLEANUP_DEPRECATED_CALL audit event
 * in the caller's tenant audit log, giving operators time to remove their jobs before
 * the stub is deleted in the next minor release.
 *
 * Replacement: `npm run worker:retention-gc` (dev) or the `retention-gc-worker` Docker service.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/auth/tokens/admin-token";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { requireMaintenanceOperator } from "@/lib/auth/access/maintenance-auth";
import { withRequestLog } from "@/lib/http/with-request-log";
import { unauthorized } from "@/lib/http/api-response";
import { RATE_WINDOW_MS } from "@/lib/validations/common.server";

// Keyed per-tenant + fail-closed on Redis error for parity with the other
// maintenance routes, even though this endpoint is a 410-Gone stub.
const rateLimiter = createRateLimiter({
  windowMs: RATE_WINDOW_MS,
  max: 1,
  failClosedOnRedisError: true,
});

async function handlePOST(req: NextRequest) {
  const authResult = await verifyAdminToken(req);
  if (!authResult.ok) {
    return unauthorized();
  }
  const { auth } = authResult;

  const blocked = await checkRateLimitOrFail({
    req,
    limiter: rateLimiter,
    key: `rl:maintenance:dcr-cleanup:${auth.tenantId}`,
    scope: "maintenance.dcr_cleanup",
    userId: auth.subjectUserId,
    tenantId: auth.tenantId,
  });
  if (blocked) return blocked;

  const op = await requireMaintenanceOperator(auth.subjectUserId, {
    tenantId: auth.tenantId,
  });
  if (!op.ok) return op.response;

  await logAuditAsync({
    ...tenantAuditBase(req, auth.subjectUserId, auth.tenantId),
    actorType: ACTOR_TYPE.HUMAN,
    action: AUDIT_ACTION.MCP_CLIENT_DCR_CLEANUP_DEPRECATED_CALL,
    metadata: {
      tokenSubjectUserId: auth.subjectUserId,
      tokenId: auth.tokenId,
      deprecated: true,
      replacement: "worker:retention-gc",
    },
  });

  return NextResponse.json(
    { error: "endpoint_removed", replacement: "worker:retention-gc" },
    { status: 410 },
  );
}

export const POST = withRequestLog(handlePOST);
