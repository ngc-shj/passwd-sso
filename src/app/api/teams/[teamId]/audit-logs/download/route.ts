import { NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission } from "@/lib/auth/access/team-auth";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { logAuditAsync, teamAuditBase } from "@/lib/audit/audit";
import { assertPolicyAllowsExport, PolicyViolationError } from "@/lib/team/team-policy";
import { API_ERROR } from "@/lib/http/api-error-codes";
import {
  TEAM_PERMISSION,
  AUDIT_ACTION,
  AUDIT_SCOPE,
} from "@/lib/constants";
import type { Prisma } from "@prisma/client";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, handleAuthError, rateLimited, unauthorized, validationError } from "@/lib/http/api-response";
import { parseActionsCsvParam, parseActorType } from "@/lib/audit/audit-query";
import { AUDIT_LOG_MAX_RANGE_DAYS } from "@/lib/validations/common.server";
import { MS_PER_DAY } from "@/lib/constants/time";
import { buildAuditLogStream, buildAuditLogDownloadResponse } from "@/lib/audit/audit-log-stream";

type Params = { params: Promise<{ teamId: string }> };

const downloadLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 2,
});

// GET /api/teams/[teamId]/audit-logs/download — Download team audit logs (ADMIN/OWNER)
async function handleGET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_UPDATE, req);
  } catch (e) {
    return handleAuthError(e);
  }

  // Check team policy allows export
  try {
    await assertPolicyAllowsExport(teamId);
  } catch (e) {
    if (e instanceof PolicyViolationError) {
      return errorResponse(API_ERROR.POLICY_EXPORT_DISABLED, 403);
    }
    throw e;
  }

  const rateKey = `rl:audit_download:team:${teamId}:${session.user.id}`;
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

  // Require at least one date boundary
  if (!from && !to) {
    return validationError({ date: "At least 'from' or 'to' is required for download" });
  }

  // Validate date range
  if (from || to) {
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
  }

  const where: Prisma.AuditLogWhereInput = {
    teamId,
    scope: AUDIT_SCOPE.TEAM,
    ...(validActorType ? { actorType: validActorType } : {}),
  };

  const parsedActions = parseActionsCsvParam(actionsParam);
  if ("invalid" in parsedActions) {
    return validationError({ actions: parsedActions.invalid });
  }
  if (parsedActions.actions.length > 0) {
    where.action = { in: parsedActions.actions };
  }

  if (from || to) {
    const createdAt: Record<string, Date> = {};
    if (from) createdAt.gte = new Date(from);
    if (to) createdAt.lte = new Date(to);
    where.createdAt = createdAt;
  }

  // Record the download itself
  await logAuditAsync({
    ...teamAuditBase(req, session.user.id, teamId),
    action: AUDIT_ACTION.AUDIT_LOG_DOWNLOAD,
    metadata: { format },
  });

  const stream = buildAuditLogStream({
    format,
    fetchBatch: ({ take, cursorId }) =>
      withTeamTenantRls(teamId, async () =>
        prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: "asc" },
          take,
          ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        }),
      ),
  });

  return buildAuditLogDownloadResponse(stream, format, "team-audit-logs");
}

export const GET = withRequestLog(handleGET);
