/**
 * POST /api/maintenance/dcr-cleanup
 *
 * DEPRECATED — returns 410 Gone for one minor version.
 *
 * DCR cleanup is now automatic: the `dcr-cleanup-worker` process runs periodic
 * sweeps and emits SYSTEM-attributed audit events. This endpoint stub authenticates
 * the caller so that stale cron jobs are surfaced via a MCP_CLIENT_DCR_CLEANUP_DEPRECATED_CALL
 * audit event in the caller's tenant audit log, giving operators time to remove their jobs
 * before the stub is deleted in the next minor release.
 *
 * Replacement: `npm run worker:dcr-cleanup` (dev) or the `dcr-cleanup-worker` Docker service.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/auth/tokens/admin-token";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { requireMaintenanceOperator } from "@/lib/auth/access/maintenance-auth";
import { withRequestLog } from "@/lib/http/with-request-log";
import { rateLimited, unauthorized } from "@/lib/http/api-response";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 1 });

async function handlePOST(req: NextRequest) {
  const authResult = await verifyAdminToken(req);
  if (!authResult.ok) {
    return unauthorized();
  }
  const { auth } = authResult;

  const rl = await rateLimiter.check("rl:admin:dcr-cleanup");
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

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
      replacement: "worker:dcr-cleanup",
    },
  });

  return NextResponse.json(
    { error: "endpoint_removed", replacement: "worker:dcr-cleanup" },
    { status: 410 },
  );
}

export const POST = withRequestLog(handlePOST);
