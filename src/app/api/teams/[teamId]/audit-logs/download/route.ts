import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import { logAuditAsync, extractRequestMeta } from "@/lib/audit";
import { assertPolicyAllowsExport } from "@/lib/team-policy";
import { PolicyViolationError } from "@/lib/team-policy";
import { API_ERROR } from "@/lib/api-error-codes";
import {
  TEAM_PERMISSION,
  AUDIT_ACTION,
  AUDIT_SCOPE,
} from "@/lib/constants";
import type { AuditAction, Prisma } from "@prisma/client";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, rateLimited, unauthorized } from "@/lib/api-response";
import { VALID_ACTIONS, parseActorType } from "@/lib/audit-query";
import { formatCsvRow } from "@/lib/audit-csv";
import { AUDIT_LOG_MAX_RANGE_DAYS, AUDIT_LOG_BATCH_SIZE } from "@/lib/validations/common.server";
import { SENTINEL_ACTOR_IDS } from "@/lib/constants/app";

type Params = { params: Promise<{ teamId: string }> };

const downloadLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 2,
});

const CSV_HEADERS = ["id", "action", "targetType", "targetId", "ip", "userAgent", "createdAt", "userId", "userName", "userEmail", "metadata"];

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
    if (e instanceof TeamAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
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

  // Validate date range
  if (from || to) {
    const fromDate = from ? new Date(from) : undefined;
    const toDate = to ? new Date(to) : undefined;
    if ((fromDate && Number.isNaN(fromDate.getTime())) || (toDate && Number.isNaN(toDate.getTime()))) {
      return NextResponse.json(
        { error: API_ERROR.VALIDATION_ERROR, details: { date: "Invalid date format" } },
        { status: 400 },
      );
    }
    const now = new Date();
    const resolvedFrom = fromDate ?? new Date(now.getTime() - AUDIT_LOG_MAX_RANGE_DAYS * 24 * 60 * 60 * 1000);
    const resolvedTo = toDate ?? now;
    const diffMs = resolvedTo.getTime() - resolvedFrom.getTime();
    if (diffMs < 0) {
      return NextResponse.json(
        { error: API_ERROR.VALIDATION_ERROR, details: { date: "'from' must be before 'to'" } },
        { status: 400 },
      );
    }
    if (diffMs > AUDIT_LOG_MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
      return NextResponse.json(
        { error: API_ERROR.VALIDATION_ERROR, details: { range: `Maximum range is ${AUDIT_LOG_MAX_RANGE_DAYS} days` } },
        { status: 400 },
      );
    }
  }

  const where: Prisma.AuditLogWhereInput = {
    teamId,
    scope: AUDIT_SCOPE.TEAM,
    ...(validActorType ? { actorType: validActorType } : {}),
  };

  if (actionsParam) {
    const requested = actionsParam.split(",").map((a) => a.trim()).filter(Boolean);
    const invalid = requested.filter((a) => !VALID_ACTIONS.has(a));
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: API_ERROR.VALIDATION_ERROR, details: { actions: invalid } },
        { status: 400 },
      );
    }
    where.action = { in: requested as AuditAction[] };
  }

  if (from || to) {
    const createdAt: Record<string, Date> = {};
    if (from) createdAt.gte = new Date(from);
    if (to) createdAt.lte = new Date(to);
    where.createdAt = createdAt;
  }

  // Record the download itself
  await logAuditAsync({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.AUDIT_LOG_DOWNLOAD,
    userId: session.user.id,
    teamId,
    metadata: { format },
    ...extractRequestMeta(req),
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

        while (hasMore) {
          const batch = await withTeamTenantRls(teamId, async () =>
            prisma.auditLog.findMany({
              where,
              orderBy: { createdAt: "asc" },
              take: AUDIT_LOG_BATCH_SIZE,
              ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
          );

          // Batch-lookup user display info for this page
          const teamDlUserIds = [
            ...new Set(
              batch
                .map((l) => l.userId)
                .filter((id): id is string => !!id && !SENTINEL_ACTOR_IDS.has(id))
            ),
          ];
          const teamDlUserMap: Record<string, { id: string; name: string | null; email: string | null }> = {};
          if (teamDlUserIds.length > 0) {
            const teamDlUsers = await withTeamTenantRls(teamId, async () =>
              prisma.user.findMany({
                where: { id: { in: teamDlUserIds } },
                select: { id: true, name: true, email: true },
              }),
            );
            for (const u of teamDlUsers) {
              teamDlUserMap[u.id] = u;
            }
          }

          for (const log of batch) {
            const userInfo = log.userId ? teamDlUserMap[log.userId] : undefined;
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
                    userInfo?.id ?? "",
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
                    user: userInfo
                      ? { id: userInfo.id, name: userInfo.name, email: userInfo.email }
                      : null,
                  }) + "\n",
                ),
              );
            }
          }

          if (batch.length < AUDIT_LOG_BATCH_SIZE) {
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
