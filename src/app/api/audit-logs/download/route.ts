import { NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { rateLimited, unauthorized, validationError } from "@/lib/http/api-response";
import {
  AUDIT_ACTION,
  AUDIT_SCOPE,
} from "@/lib/constants";
import type { Prisma } from "@prisma/client";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/http/with-request-log";
import { parseActionsCsvParam, parseActorType } from "@/lib/audit/audit-query";
import { AUDIT_LOG_MAX_RANGE_DAYS } from "@/lib/validations/common.server";
import { MS_PER_DAY } from "@/lib/constants/time";
import { buildAuditLogStream, buildAuditLogDownloadResponse } from "@/lib/audit/audit-log-stream";

const downloadLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 2,
});

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
  const validActorType = parseActorType(searchParams);

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

  // TODO(audit-log-download-emergency-access-or-clause): personal LIST endpoint
  // (audit-logs/route.ts:44-57) surfaces EMERGENCY_VAULT_ACCESS events targeting
  // session.user.id via an OR branch; this download endpoint does not. Symmetry
  // gap is pre-existing UX (under-disclosure), not security; deferred per plan.
  const where: Prisma.AuditLogWhereInput = {
    scope: AUDIT_SCOPE.PERSONAL,
    userId: session.user.id,
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
    ...personalAuditBase(req, session.user.id),
    action: AUDIT_ACTION.AUDIT_LOG_DOWNLOAD,
    metadata: { format },
  });

  const userId = session.user.id;

  const stream = buildAuditLogStream({
    format,
    fetchBatch: ({ take, cursorId }) =>
      withUserTenantRls(userId, async () =>
        prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: "asc" },
          take,
          ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        }),
      ),
  });

  return buildAuditLogDownloadResponse(stream, format, "audit-logs");
}

export const GET = withRequestLog(handleGET);
