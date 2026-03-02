import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { assertPolicyAllowsExport } from "@/lib/team-policy";
import { PolicyViolationError } from "@/lib/team-policy";
import { API_ERROR } from "@/lib/api-error-codes";
import {
  TEAM_PERMISSION,
  AUDIT_ACTION,
  AUDIT_ACTION_VALUES,
  AUDIT_SCOPE,
} from "@/lib/constants";
import type { AuditAction, Prisma } from "@prisma/client";
import { withTeamTenantRls } from "@/lib/tenant-context";

type Params = { params: Promise<{ teamId: string }> };

const VALID_ACTIONS: Set<string> = new Set(AUDIT_ACTION_VALUES);
const BATCH_SIZE = 500;
const MAX_RANGE_DAYS = 90;

const downloadLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 2,
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

// GET /api/teams/[teamId]/audit-logs/download — Download team audit logs (ADMIN/OWNER)
export async function GET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_UPDATE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  // Check team policy allows export
  try {
    await assertPolicyAllowsExport(teamId);
  } catch (e) {
    if (e instanceof PolicyViolationError) {
      return NextResponse.json({ error: API_ERROR.POLICY_EXPORT_DISABLED }, { status: 403 });
    }
    throw e;
  }

  const rateKey = `rl:audit_download:team:${teamId}:${session.user.id}`;
  if (!(await downloadLimiter.check(rateKey))) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 },
    );
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
      return NextResponse.json(
        { error: API_ERROR.VALIDATION_ERROR, details: { date: "Invalid date format" } },
        { status: 400 },
      );
    }
    const now = new Date();
    const resolvedFrom = fromDate ?? new Date(now.getTime() - MAX_RANGE_DAYS * 24 * 60 * 60 * 1000);
    const resolvedTo = toDate ?? now;
    const diffMs = resolvedTo.getTime() - resolvedFrom.getTime();
    if (diffMs < 0) {
      return NextResponse.json(
        { error: API_ERROR.VALIDATION_ERROR, details: { date: "'from' must be before 'to'" } },
        { status: 400 },
      );
    }
    if (diffMs > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
      return NextResponse.json(
        { error: API_ERROR.VALIDATION_ERROR, details: { range: `Maximum range is ${MAX_RANGE_DAYS} days` } },
        { status: 400 },
      );
    }
  }

  const where: Prisma.AuditLogWhereInput = {
    teamId,
    scope: AUDIT_SCOPE.TEAM,
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
  logAudit({
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
              include: {
                user: { select: { id: true, name: true, email: true } },
              },
              orderBy: { createdAt: "asc" },
              take: BATCH_SIZE,
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

          if (batch.length < BATCH_SIZE) {
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
