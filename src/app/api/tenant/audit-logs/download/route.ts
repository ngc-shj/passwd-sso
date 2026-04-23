import { NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission } from "@/lib/auth/tenant-auth";
import { TENANT_PERMISSION } from "@/lib/constants/tenant-permission";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { createRateLimiter } from "@/lib/rate-limit";
import { handleAuthError, rateLimited, unauthorized, validationError } from "@/lib/api-response";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { parseActionsCsvParam } from "@/lib/audit-query";
import { AUDIT_LOG_MAX_RANGE_DAYS } from "@/lib/validations/common.server";
import { MS_PER_DAY } from "@/lib/constants/time";
import { buildAuditLogStream, buildAuditLogDownloadResponse } from "@/lib/audit-log-stream";

const downloadLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 3,
});

// GET /api/tenant/audit-logs/download — Download tenant audit logs (JSONL or CSV, ADMIN/OWNER only)
async function handleGET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  let actor;
  try {
    actor = await requireTenantPermission(session.user.id, TENANT_PERMISSION.AUDIT_LOG_VIEW);
  } catch (e) {
    return handleAuthError(e);
  }

  const rateKey = `rl:tenant_audit_download:${session.user.id}`;
  const rl = await downloadLimiter.check(rateKey);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const { searchParams } = new URL(req.url);
  const format = searchParams.get("format") === "csv" ? "csv" : "jsonl";
  const actionsParam = searchParams.get("actions");
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  // Require at least one date boundary
  if (!from && !to) {
    return validationError({ date: "At least 'from' or 'to' is required for download" });
  }

  // Validate date range (from || to is always true here due to early return above)
  const fromDate = from ? new Date(from) : undefined;
  const toDate = to ? new Date(to) : undefined;
  if ((fromDate && Number.isNaN(fromDate.getTime())) || (toDate && Number.isNaN(toDate.getTime()))) {
    return validationError({ date: "Invalid date format" });
  }
  const now = new Date();
  const resolvedFrom = fromDate ?? new Date(now.getTime() - AUDIT_LOG_MAX_RANGE_DAYS * MS_PER_DAY);
  const resolvedTo = toDate ?? now;
  const diffMs = resolvedTo.getTime() - resolvedFrom.getTime();
  if (diffMs < 0) {
    return validationError({ date: "'from' must be before 'to'" });
  }
  if (diffMs > AUDIT_LOG_MAX_RANGE_DAYS * MS_PER_DAY) {
    return validationError({ range: `Maximum range is ${AUDIT_LOG_MAX_RANGE_DAYS} days` });
  }

  const where: Record<string, unknown> = {
    scope: { in: [AUDIT_SCOPE.TENANT, AUDIT_SCOPE.TEAM] },
    tenantId: actor.tenantId,
  };

  const parsedActions = parseActionsCsvParam(actionsParam);
  if ("invalid" in parsedActions) {
    return validationError({ actions: parsedActions.invalid });
  }
  if (parsedActions.actions.length > 0) {
    where.action = { in: parsedActions.actions };
  }

  where.createdAt = {
    gte: resolvedFrom,
    lte: resolvedTo,
  };

  // Record the download itself
  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.AUDIT_LOG_DOWNLOAD,
    metadata: { format },
  });

  const tenantId = actor.tenantId;

  const stream = buildAuditLogStream({
    format,
    fetchBatch: ({ take, cursorId }) =>
      withTenantRls(prisma, tenantId, async () =>
        prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: "asc" },
          take,
          ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        }),
      ),
  });

  return buildAuditLogDownloadResponse(stream, format, "tenant-audit-logs");
}

export const GET = withRequestLog(handleGET);
