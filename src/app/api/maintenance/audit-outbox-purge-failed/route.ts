/**
 * POST /api/maintenance/audit-outbox-purge-failed
 *
 * Operator-driven explicit purge of FAILED outbox rows.
 * Authenticated via ADMIN_API_TOKEN bearer token (not session).
 *
 * Body: { operatorId: string, tenantId?: string, olderThanDays?: number }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { parseBody } from "@/lib/parse-body";
import { verifyAdminToken } from "@/lib/admin-token";
import { createRateLimiter } from "@/lib/rate-limit";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit";
import { AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { requireMaintenanceOperator } from "@/lib/maintenance-auth";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { withRequestLog } from "@/lib/with-request-log";
import { rateLimited, unauthorized } from "@/lib/api-response";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 1 });

const bodySchema = z.object({
  operatorId: z.string().uuid(),
  tenantId: z.string().uuid().optional(),
  olderThanDays: z.number().int().min(1).optional(),
});

async function handlePOST(req: NextRequest) {
  if (!verifyAdminToken(req)) {
    return unauthorized();
  }

  const rl = await rateLimiter.check("rl:admin:outbox-purge");
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const result = await parseBody(req, bodySchema);
  if (!result.ok) return result.response;

  const { operatorId, tenantId: filterTenantId, olderThanDays } = result.data;

  const op = await requireMaintenanceOperator(operatorId);
  if (!op.ok) return op.response;
  const membership = op.operator;

  const tenantFilter = filterTenantId ?? null;
  const daysFilter = olderThanDays ?? null;

  const rows = await withBypassRls(prisma, async () =>
    prisma.$queryRaw<{ purged: bigint }[]>`
      WITH deleted AS (
        DELETE FROM audit_outbox
        WHERE status = 'FAILED'
          AND (${tenantFilter}::uuid IS NULL OR tenant_id = ${tenantFilter}::uuid)
          AND (${daysFilter}::int IS NULL OR created_at < now() - make_interval(days => ${daysFilter}::int))
        RETURNING id
      ) SELECT COUNT(*) AS purged FROM deleted
    `,
  BYPASS_PURPOSE.SYSTEM_MAINTENANCE);

  const purged = Number(rows[0]?.purged ?? 0);

  await logAuditAsync({
    ...tenantAuditBase(req, SYSTEM_ACTOR_ID, membership.tenantId),
    actorType: ACTOR_TYPE.SYSTEM,
    action: AUDIT_ACTION.AUDIT_OUTBOX_PURGE_EXECUTED,
    metadata: {
      operatorId,
      purgedCount: purged,
      filterTenantId: filterTenantId ?? null,
      olderThanDays: olderThanDays ?? null,
    },
  });

  return NextResponse.json({ purged });
}

export const POST = withRequestLog(handlePOST);
