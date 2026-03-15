import { NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission, TenantAuthError } from "@/lib/tenant-auth";
import { TENANT_PERMISSION } from "@/lib/constants/tenant-permission";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, unauthorized, validationError } from "@/lib/api-response";
import {
  AUDIT_ACTION,
  AUDIT_ACTION_VALUES,
  AUDIT_SCOPE,
} from "@/lib/constants";
import type { AuditAction } from "@prisma/client";

const VALID_ACTIONS: Set<string> = new Set(AUDIT_ACTION_VALUES);
const BATCH_SIZE = 500;
const MAX_RANGE_DAYS = 90;
const MAX_ROWS = 100_000;

const downloadLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 1,
});

function escapeCsvValue(v: string): string {
  // Prevent CSV injection: escape values starting with formula-triggering characters
  const escaped = v.replace(/"/g, '""');
  if (/^[=+\-@\t\r]/.test(escaped)) {
    return `"'${escaped}"`;
  }
  return `"${escaped}"`;
}

function formatCsvRow(values: string[]): string {
  return values.map(escapeCsvValue).join(",");
}

const CSV_HEADERS = ["id", "action", "targetType", "targetId", "ip", "userAgent", "createdAt", "userId", "userName", "userEmail", "metadata"];

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
    if (e instanceof TenantAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
  }

  const rateKey = `rl:tenant_audit_download:${session.user.id}`;
  if (!(await downloadLimiter.check(rateKey)).allowed) {
    return errorResponse(API_ERROR.RATE_LIMIT_EXCEEDED, 429);
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

  // Validate date range
  if (from || to) {
    const fromDate = from ? new Date(from) : undefined;
    const toDate = to ? new Date(to) : undefined;
    if ((fromDate && isNaN(fromDate.getTime())) || (toDate && isNaN(toDate.getTime()))) {
      return validationError({ date: "Invalid date format" });
    }
    const now = new Date();
    const resolvedFrom = fromDate ?? new Date(now.getTime() - MAX_RANGE_DAYS * 24 * 60 * 60 * 1000);
    const resolvedTo = toDate ?? now;
    const diffMs = resolvedTo.getTime() - resolvedFrom.getTime();
    if (diffMs < 0) {
      return validationError({ date: "'from' must be before 'to'" });
    }
    if (diffMs > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
      return validationError({ range: `Maximum range is ${MAX_RANGE_DAYS} days` });
    }
  }

  const where: Record<string, unknown> = {
    scope: { in: [AUDIT_SCOPE.TENANT, AUDIT_SCOPE.TEAM] },
    tenantId: actor.tenantId,
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
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.AUDIT_LOG_DOWNLOAD,
    userId: session.user.id,
    tenantId: actor.tenantId,
    metadata: { format },
    ...extractRequestMeta(req),
  });

  const tenantId = actor.tenantId;

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
          const remaining = MAX_ROWS - totalRows;
          const batchSize = Math.min(BATCH_SIZE, remaining);

          const batch = await withTenantRls(prisma, tenantId, async () =>
            prisma.auditLog.findMany({
              where,
              include: {
                user: { select: { id: true, name: true, email: true } },
              },
              orderBy: { createdAt: "asc" },
              take: batchSize,
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

          if (batch.length < batchSize || totalRows >= MAX_ROWS) {
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
      "Content-Disposition": `attachment; filename="tenant-audit-logs.${ext}"`,
      "Cache-Control": "no-store",
    },
  });
}

export const GET = withRequestLog(handleGET);
