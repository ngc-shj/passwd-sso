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
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { AUDIT_SCOPE, AUDIT_ACTION } from "@/lib/constants/audit";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
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

  const membership = await withBypassRls(prisma, async () =>
    prisma.tenantMember.findFirst({
      where: {
        userId: operatorId,
        role: { in: ["OWNER", "ADMIN"] },
        deactivatedAt: null,
      },
      select: { tenantId: true },
    }),
  BYPASS_PURPOSE.SYSTEM_MAINTENANCE);
  if (!membership) {
    return NextResponse.json(
      { error: "operatorId is not an active tenant admin" },
      { status: 400 },
    );
  }

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

  const { ip, userAgent } = extractRequestMeta(req);
  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.AUDIT_OUTBOX_PURGE_EXECUTED,
    userId: operatorId,
    tenantId: membership.tenantId,
    metadata: {
      purgedCount: purged,
      filterTenantId: filterTenantId ?? null,
      olderThanDays: olderThanDays ?? null,
    },
    ip,
    userAgent,
  });

  return NextResponse.json({ purged });
}

export const POST = withRequestLog(handlePOST);
