import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission } from "@/lib/team-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import { logAuditAsync, teamAuditBase } from "@/lib/audit";
import { assertPolicyAllowsExport, PolicyViolationError } from "@/lib/team-policy";
import { API_ERROR } from "@/lib/api-error-codes";
import {
  TEAM_PERMISSION,
  AUDIT_ACTION,
  AUDIT_SCOPE,
} from "@/lib/constants";
import type { AuditAction, Prisma } from "@prisma/client";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, handleAuthError, rateLimited, unauthorized, validationError } from "@/lib/api-response";
import { parseActionsCsvParam, parseActorType } from "@/lib/audit-query";
import { formatCsvRow, AUDIT_LOG_CSV_HEADERS } from "@/lib/audit-csv";
import { AUDIT_LOG_MAX_RANGE_DAYS, AUDIT_LOG_BATCH_SIZE, AUDIT_LOG_MAX_ROWS } from "@/lib/validations/common.server";
import { fetchAuditUserMap } from "@/lib/audit-user-lookup";
import { MS_PER_DAY } from "@/lib/constants/time";

type Params = { params: Promise<{ teamId: string }> };

const downloadLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 2,
});

const CSV_HEADERS = AUDIT_LOG_CSV_HEADERS;

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

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        if (format === "csv") {
          controller.enqueue(encoder.encode(CSV_HEADERS.join(",") + "\n"));
        }

        let cursor: string | undefined;
        let hasMore = true;
        let totalRows = 0;

        while (hasMore && totalRows < AUDIT_LOG_MAX_ROWS) {
          const remaining = AUDIT_LOG_MAX_ROWS - totalRows;
          const batchSize = Math.min(AUDIT_LOG_BATCH_SIZE, remaining);

          const batch = await withTeamTenantRls(teamId, async () =>
            prisma.auditLog.findMany({
              where,
              orderBy: { createdAt: "asc" },
              take: batchSize,
              ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
          );

          // Batch-lookup user display info for this page
          const teamDlUserMap = await fetchAuditUserMap(batch.map((l) => l.userId));

          for (const log of batch) {
            const userInfo = log.userId ? (teamDlUserMap.get(log.userId) ?? undefined) : undefined;
            if (format === "csv") {
              controller.enqueue(
                encoder.encode(
                  formatCsvRow([
                    log.id,
                    log.action,
                    log.targetType ?? "",
                    log.targetId ?? "",
                    log.ip ?? "",
                    log.userAgent ?? "",
                    log.createdAt.toISOString(),
                    log.userId ?? "",
                    log.actorType ?? "",
                    userInfo?.name ?? "",
                    userInfo?.email ?? "",
                    JSON.stringify(log.metadata ?? {}),
                  ]) + "\n",
                ),
              );
            } else {
              controller.enqueue(
                encoder.encode(
                  JSON.stringify({
                    id: log.id,
                    action: log.action,
                    targetType: log.targetType,
                    targetId: log.targetId,
                    metadata: log.metadata,
                    ip: log.ip,
                    userAgent: log.userAgent,
                    createdAt: log.createdAt,
                    userId: log.userId,
                    actorType: log.actorType,
                    user: userInfo
                      ? { id: userInfo.id, name: userInfo.name, email: userInfo.email }
                      : null,
                  }) + "\n",
                ),
              );
            }
          }

          totalRows += batch.length;

          if (batch.length < batchSize || totalRows >= AUDIT_LOG_MAX_ROWS) {
            hasMore = false;
          } else {
            cursor = batch[batch.length - 1].id;
          }
        }
      } catch (err) {
        controller.error(err);
        return;
      }
      controller.close();
    },
  });

  const contentType = format === "csv" ? "text/csv" : "application/x-ndjson";
  const ext = format === "csv" ? "csv" : "jsonl";

  return new Response(stream, {
    headers: {
      "Content-Type": `${contentType}; charset=utf-8`,
      "Content-Disposition": `attachment; filename="team-audit-logs.${ext}"`,
      "Cache-Control": "no-store",
    },
  });
}

export const GET = withRequestLog(handleGET);
