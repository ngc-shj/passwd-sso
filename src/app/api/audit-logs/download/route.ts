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
import { auditDownloadFilterMetadata, parseActionsCsvParam, parseActorType, resolveDownloadRange } from "@/lib/audit/audit-query";
import { RATE_WINDOW_MS } from "@/lib/validations/common.server";
import { buildAuditLogStream, buildAuditLogDownloadResponse } from "@/lib/audit/audit-log-stream";

const downloadLimiter = createRateLimiter({
  windowMs: RATE_WINDOW_MS,
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
  const resolved = resolveDownloadRange(from, to);
  if ("error" in resolved) return validationError(resolved.error);
  const { range } = resolved;

  // TODO(audit-log-download-emergency-access-or-clause): download omits the OR-branch for EMERGENCY_VAULT_ACCESS events present in the list endpoint; pre-existing UX gap, not security.
  const where: Prisma.AuditLogWhereInput = {
    scope: AUDIT_SCOPE.PERSONAL,
    userId: session.user.id,
  };

  if (validActorType) where.actorType = validActorType;

  const parsedActions = parseActionsCsvParam(actionsParam);
  if ("invalid" in parsedActions) {
    return validationError({ actions: parsedActions.invalid });
  }
  if (parsedActions.actions.length > 0) {
    where.action = { in: parsedActions.actions };
  }

  if (range) where.createdAt = range;

  // Record the download itself
  await logAuditAsync({
    ...personalAuditBase(req, session.user.id),
    action: AUDIT_ACTION.AUDIT_LOG_DOWNLOAD,
    metadata: {
      format,
      ...auditDownloadFilterMetadata({
        from: range?.gte,
        to: range?.lte,
        actions: parsedActions.actions,
        actorType: validActorType,
      }),
    },
  });

  const userId = session.user.id;

  const stream = buildAuditLogStream({
    format,
    fetchBatch: ({ take, cursorId }) =>
      withUserTenantRls(userId, async () =>
        prisma.auditLog.findMany({
          where,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take,
          ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        }),
      ),
  });

  return buildAuditLogDownloadResponse(stream, format, "audit-logs");
}

export const GET = withRequestLog(handleGET);
