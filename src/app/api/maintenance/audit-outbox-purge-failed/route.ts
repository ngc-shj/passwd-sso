/**
 * POST /api/maintenance/audit-outbox-purge-failed
 *
 * Operator-driven explicit purge of FAILED outbox rows.
 * Authenticated via per-operator op_* token (mint via /dashboard/tenant/operator-tokens).
 *
 * Body: { tenantId?: string, olderThanDays?: number }
 *   tenantId — optional filter (which tenant's failed rows to purge)
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
import { rateLimited, unauthorized } from "@/lib/http/api-response";

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

  const op = await requireMaintenanceOperator(auth.subjectUserId, {
    tenantId: auth.tenantId,
  });
  if (!op.ok) return op.response;

  const tenantFilter = filterTenantId ?? null;
  const daysFilter = olderThanDays ?? null;

  const rows = await withBypassRls(
    prisma,
    async () =>
      prisma.$queryRaw<{ purged: bigint }[]>`
        WITH deleted AS (
          DELETE FROM audit_outbox
          WHERE status = 'FAILED'
            AND (${tenantFilter}::uuid IS NULL OR tenant_id = ${tenantFilter}::uuid)
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
      filterTenantId: filterTenantId ?? null,
      olderThanDays: olderThanDays ?? null,
    },
  });

  return NextResponse.json({ purged });
}

export const POST = withRequestLog(handlePOST);
