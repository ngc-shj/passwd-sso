/**
 * Shared ReadableStream + cursor-paginated audit-log download helper.
 *
 * The 3 audit-log download routes (personal, team, tenant) all need the same
 * loop: cursor through the rows in batches, enrich each row with user display
 * info, and emit each row as either CSV or JSONL. The only per-route axis of
 * variation is the RLS context (withUserTenantRls / withTeamTenantRls /
 * withTenantRls), which the caller supplies via the `fetchBatch` callback.
 */

import type { AuditLog } from "@prisma/client";
import { formatCsvRow, AUDIT_LOG_CSV_HEADERS } from "@/lib/audit-csv";
import { AUDIT_LOG_BATCH_SIZE, AUDIT_LOG_MAX_ROWS } from "@/lib/validations/common.server";
import { fetchAuditUserMap } from "@/lib/audit-user-lookup";

export type AuditLogFormat = "csv" | "jsonl";

type AuditLogRow = Pick<
  AuditLog,
  "id" | "action" | "targetType" | "targetId" | "ip" | "userAgent" | "createdAt" | "userId" | "actorType" | "metadata"
>;

/**
 * Fetch a single page of audit-log rows. Implementations wrap the `findMany`
 * call in whatever RLS context is appropriate for the route (user/team/tenant).
 */
export type FetchAuditLogBatch = (opts: {
  take: number;
  cursorId: string | undefined;
}) => Promise<AuditLogRow[]>;

export interface BuildAuditLogStreamOptions {
  format: AuditLogFormat;
  fetchBatch: FetchAuditLogBatch;
}

/**
 * Build a ReadableStream that emits audit-log rows paginated via a cursor.
 * Respects AUDIT_LOG_BATCH_SIZE per fetch and AUDIT_LOG_MAX_ROWS total.
 */
export function buildAuditLogStream({
  format,
  fetchBatch,
}: BuildAuditLogStreamOptions): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        if (format === "csv") {
          controller.enqueue(encoder.encode(AUDIT_LOG_CSV_HEADERS.join(",") + "\n"));
        }

        let cursorId: string | undefined;
        let hasMore = true;
        let totalRows = 0;

        while (hasMore && totalRows < AUDIT_LOG_MAX_ROWS) {
          const remaining = AUDIT_LOG_MAX_ROWS - totalRows;
          const take = Math.min(AUDIT_LOG_BATCH_SIZE, remaining);

          const batch = await fetchBatch({ take, cursorId });
          const userMap = await fetchAuditUserMap(batch.map((l) => l.userId));

          for (const log of batch) {
            const userInfo = log.userId ? (userMap.get(log.userId) ?? undefined) : undefined;
            controller.enqueue(encoder.encode(formatRow(format, log, userInfo)));
          }

          totalRows += batch.length;
          if (batch.length < take || totalRows >= AUDIT_LOG_MAX_ROWS) {
            hasMore = false;
          } else {
            cursorId = batch[batch.length - 1].id;
          }
        }
      } catch (err) {
        controller.error(err);
        return;
      }
      controller.close();
    },
  });
}

function formatRow(
  format: AuditLogFormat,
  log: AuditLogRow,
  userInfo: { id: string; name: string | null; email: string | null } | undefined,
): string {
  if (format === "csv") {
    return formatCsvRow([
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
    ]) + "\n";
  }
  return JSON.stringify({
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
  }) + "\n";
}

/** Build the Response object with proper headers for an audit-log download. */
export function buildAuditLogDownloadResponse(
  stream: ReadableStream<Uint8Array>,
  format: AuditLogFormat,
  filenameStem: string,
): Response {
  const contentType = format === "csv" ? "text/csv" : "application/x-ndjson";
  const ext = format === "csv" ? "csv" : "jsonl";
  return new Response(stream, {
    headers: {
      "Content-Type": `${contentType}; charset=utf-8`,
      "Content-Disposition": `attachment; filename="${filenameStem}.${ext}"`,
      "Cache-Control": "no-store",
    },
  });
}
