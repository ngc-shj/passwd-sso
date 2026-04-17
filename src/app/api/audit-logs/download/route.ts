import { NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/rate-limit";
import { logAuditAsync, extractRequestMeta } from "@/lib/audit";
import { rateLimited, unauthorized, validationError } from "@/lib/api-response";
import {
  AUDIT_ACTION,
  AUDIT_SCOPE,
} from "@/lib/constants";
import type { AuditAction, Prisma } from "@prisma/client";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import { VALID_ACTIONS } from "@/lib/audit-query";
import { formatCsvRow, AUDIT_LOG_CSV_HEADERS } from "@/lib/audit-csv";
import { AUDIT_LOG_MAX_RANGE_DAYS, AUDIT_LOG_BATCH_SIZE, AUDIT_LOG_MAX_ROWS } from "@/lib/validations/common.server";
import { MS_PER_DAY } from "@/lib/constants/time";
import { fetchAuditUserMap } from "@/lib/audit-user-lookup";

const downloadLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 2,
});

const CSV_HEADERS = AUDIT_LOG_CSV_HEADERS;

// GET /api/audit-logs/download — Download personal audit logs (JSONL or CSV)
async function handleGET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const rateKey = `rl:audit_download:${session.user.id}`;
  const rl = await downloadLimiter.check(rateKey);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
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
  await logAuditAsync({
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

        while (hasMore && totalRows < AUDIT_LOG_MAX_ROWS) {
          const remaining = AUDIT_LOG_MAX_ROWS - totalRows;
          const batchSize = Math.min(AUDIT_LOG_BATCH_SIZE, remaining);

          const batch = await withUserTenantRls(userId, async () =>
            prisma.auditLog.findMany({
              where,
              orderBy: { createdAt: "asc" },
              take: batchSize,
              ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
          );

          // Batch-lookup user display info for this page
          const batchUserMap = await fetchAuditUserMap(batch.map((l) => l.userId));

          for (const log of batch) {
            const userInfo = log.userId ? (batchUserMap.get(log.userId) ?? undefined) : undefined;
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
      "Content-Disposition": `attachment; filename="audit-logs.${ext}"`,
      "Cache-Control": "no-store",
    },
  });
}

export const GET = withRequestLog(handleGET);
