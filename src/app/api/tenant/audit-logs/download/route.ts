import { NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/http/with-request-log";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { handleAuthError, rateLimited, unauthorized, validationError } from "@/lib/http/api-response";
import { AUDIT_ACTION } from "@/lib/constants";
import { auditDownloadFilterMetadata, parseActionsCsvParam, parseActorType, parseActorUserId } from "@/lib/audit/audit-query";
import { appliedTenantAuditFilters, buildTenantAuditWhere, validateTenantAuditTeam } from "@/lib/audit/tenant-audit-filter";
import { AUDIT_LOG_MAX_RANGE_DAYS } from "@/lib/validations/common";
import { RATE_WINDOW_MS } from "@/lib/validations/common.server";
import { MS_PER_DAY } from "@/lib/constants/time";
import { buildAuditLogStream, buildAuditLogDownloadResponse } from "@/lib/audit/audit-log-stream";

const downloadLimiter = createRateLimiter({
  windowMs: RATE_WINDOW_MS,
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
  const validActorType = parseActorType(searchParams);
  const scopeParam = searchParams.get("scope");
  const teamIdParam = searchParams.get("teamId");
  const actorUser = parseActorUserId(searchParams);
  if ("invalid" in actorUser) {
    return validationError({ userId: "Invalid user id" });
  }

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

  // Validate teamId belongs to this tenant before any log query or download audit row
  if (teamIdParam) {
    const teamOk = await withTenantRls(prisma, actor.tenantId, async (tx) =>
      validateTenantAuditTeam(tx, actor.tenantId, teamIdParam),
    );
    if (!teamOk) {
      return validationError({ teamId: "Team not found" });
    }
  }

  const where = buildTenantAuditWhere({
    tenantId: actor.tenantId,
    scope: scopeParam,
    teamId: teamIdParam,
    actorType: validActorType,
    userId: actorUser.userId,
  });

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
    metadata: {
      format,
      ...auditDownloadFilterMetadata({
        from: resolvedFrom,
        to: resolvedTo,
        actions: parsedActions.actions,
        actorType: validActorType,
      }),
      ...(actorUser.userId && { actorUserId: actorUser.userId }),
      ...appliedTenantAuditFilters(scopeParam, teamIdParam),
    },
  });

  const tenantId = actor.tenantId;

  const stream = buildAuditLogStream({
    format,
    fetchBatch: ({ take, cursorId }) =>
      withTenantRls(prisma, tenantId, async (tx) =>
        tx.auditLog.findMany({
          where,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take,
          ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        }),
      ),
  });

  return buildAuditLogDownloadResponse(stream, format, "tenant-audit-logs");
}

export const GET = withRequestLog(handleGET);
