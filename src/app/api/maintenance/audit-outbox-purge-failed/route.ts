/**
 * POST /api/maintenance/audit-outbox-purge-failed
 *
 * Operator-driven explicit purge of FAILED outbox rows for the operator-token's
 * bound tenant. Cross-tenant purge is rejected (403); the optional `tenantId`
 * body field exists only for explicitness and MUST equal the token's tenantId.
 * Authenticated via per-operator op_* token (mint via /dashboard/tenant/operator-tokens).
 *
 * Body: { tenantId?: string, olderThanDays?: number }
 *   tenantId — optional, must match the operator-token's tenantId when provided
 *   olderThanDays — optional age filter
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { parseBody } from "@/lib/http/parse-body";
import { verifyAdminToken } from "@/lib/auth/tokens/admin-token";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { requireMaintenanceOperator } from "@/lib/auth/access/maintenance-auth";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, rateLimited, unauthorized } from "@/lib/http/api-response";
import { API_ERROR } from "@/lib/http/api-error-codes";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 1 });

const bodySchema = z.object({
  tenantId: z.string().uuid().optional(),
  olderThanDays: z.number().int().min(1).optional(),
});

async function handlePOST(req: NextRequest) {
  const authResult = await verifyAdminToken(req);
  if (!authResult.ok) {
    return unauthorized();
  }
  const { auth } = authResult;

  const rl = await rateLimiter.check("rl:admin:outbox-purge");
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const result = await parseBody(req, bodySchema);
  if (!result.ok) return result.response;

  const { tenantId: filterTenantId, olderThanDays } = result.data;

  // Operator-token boundary: a token is bound to a single tenant. Reject
  // cross-tenant purge requests; multi-tenant operators must mint a separate
  // token per tenant. Body-supplied tenantId is accepted only as an explicit
  // restatement of auth.tenantId — never as a way to target another tenant.
  if (filterTenantId !== undefined && filterTenantId !== auth.tenantId) {
    return errorResponse(API_ERROR.FORBIDDEN, 403);
  }

  const op = await requireMaintenanceOperator(auth.subjectUserId, {
    tenantId: auth.tenantId,
  });
  if (!op.ok) return op.response;

  const tenantFilter = auth.tenantId;
  const daysFilter = olderThanDays ?? null;

  const rows = await withBypassRls(
    prisma,
    async () =>
      prisma.$queryRaw<{ purged: bigint }[]>`
        WITH deleted AS (
          DELETE FROM audit_outbox
          WHERE status = 'FAILED'
            AND tenant_id = ${tenantFilter}::uuid
            AND (${daysFilter}::int IS NULL OR created_at < now() - make_interval(days => ${daysFilter}::int))
          RETURNING id
        ) SELECT COUNT(*) AS purged FROM deleted
      `,
    BYPASS_PURPOSE.SYSTEM_MAINTENANCE,
  );

  const purged = Number(rows[0]?.purged ?? 0);

  await logAuditAsync({
    ...tenantAuditBase(req, auth.subjectUserId, auth.tenantId),
    actorType: ACTOR_TYPE.HUMAN,
    action: AUDIT_ACTION.AUDIT_OUTBOX_PURGE_EXECUTED,
    metadata: {
      tokenSubjectUserId: auth.subjectUserId,
      tokenId: auth.tokenId,
      purgedCount: purged,
      scopedTenantId: auth.tenantId,
      olderThanDays: olderThanDays ?? null,
    },
  });

  return NextResponse.json({ purged });
}

export const POST = withRequestLog(handlePOST);
