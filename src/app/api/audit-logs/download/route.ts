import { NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/rate-limit";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, unauthorized, validationError } from "@/lib/api-response";
import {
  AUDIT_ACTION,
  AUDIT_SCOPE,
} from "@/lib/constants";
import type { AuditAction, Prisma } from "@prisma/client";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import { VALID_ACTIONS } from "@/lib/audit-query";
import { formatCsvRow } from "@/lib/audit-csv";
import { AUDIT_LOG_MAX_RANGE_DAYS, AUDIT_LOG_BATCH_SIZE, AUDIT_LOG_MAX_ROWS } from "@/lib/validations/common.server";

const downloadLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 2,
});

const CSV_HEADERS = ["id", "action", "targetType", "targetId", "ip", "userAgent", "createdAt", "userId", "userName", "userEmail", "metadata"];

// GET /api/audit-logs/download — Download personal audit logs (JSONL or CSV)
async function handleGET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const rateKey = `rl:audit_download:${session.user.id}`;
  if (!(await downloadLimiter.check(rateKey)).allowed) {
    return errorResponse(API_ERROR.RATE_LIMIT_EXCEEDED, 429);
  }

  const { searchParams } = new URL(req.url);
  const format = searchParams.get("format") === "csv" ? "csv" : "jsonl";
  const actionsParam = searchParams.get("actions");
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  // Validate date range
  if (from || to) {
    const fromDate = from ? new Date(from) : undefined;
    const toDate = to ? new Date(to) : undefined;
    if ((fromDate && isNaN(fromDate.getTime())) || (toDate && isNaN(toDate.getTime()))) {
      return validationError({ date: "Invalid date format" });
    }
    const now = new Date();
    const resolvedFrom = fromDate ?? new Date(now.getTime() - AUDIT_LOG_MAX_RANGE_DAYS * 24 * 60 * 60 * 1000);
    const resolvedTo = toDate ?? now;
    const diffMs = resolvedTo.getTime() - resolvedFrom.getTime();
    if (diffMs < 0) {
      return validationError({ date: "'from' must be before 'to'" });
    }
    if (diffMs > AUDIT_LOG_MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
      return validationError({ range: `Maximum range is ${AUDIT_LOG_MAX_RANGE_DAYS} days` });
    }
  }

  const where: Prisma.AuditLogWhereInput = {
    scope: AUDIT_SCOPE.PERSONAL,
    userId: session.user.id,
  };

  if (actionsParam) {
    const requested = actionsParam.split(",").map((a) => a.trim()).filter(Boolean);
    const invalid = requested.filter((a) => !VALID_ACTIONS.has(a));
    if (invalid.length > 0) {
      return validationError({ actions: invalid });
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
  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.AUDIT_LOG_DOWNLOAD,
    userId: session.user.id,
    metadata: { format },
    ...extractRequestMeta(req),
  });

  const userId = session.user.id;

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

        while (hasMore) {
          const batch = await withUserTenantRls(userId, async () =>
            prisma.auditLog.findMany({
              where,
              include: {
                user: { select: { id: true, name: true, email: true } },
              },
              orderBy: { createdAt: "asc" },
              take: AUDIT_LOG_BATCH_SIZE,
              ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
          );

          for (const log of batch) {
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
                    log.user?.id ?? "",
                    log.user?.name ?? "",
                    log.user?.email ?? "",
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
                    user: log.user
                      ? { id: log.user.id, name: log.user.name, email: log.user.email }
                      : null,
                  }) + "\n",
                ),
              );
            }
          }

          totalRows += batch.length;
          if (batch.length < AUDIT_LOG_BATCH_SIZE || totalRows >= AUDIT_LOG_MAX_ROWS) {
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
      "Content-Disposition": `attachment; filename="audit-logs.${ext}"`,
      "Cache-Control": "no-store",
    },
  });
}

export const GET = withRequestLog(handleGET);
