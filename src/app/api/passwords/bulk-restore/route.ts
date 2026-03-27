import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, logAuditBatch, extractRequestMeta } from "@/lib/audit";
import { withRequestLog } from "@/lib/with-request-log";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { unauthorized } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";
import { bulkIdsSchema } from "@/lib/validations";

// POST /api/passwords/bulk-restore - Restore multiple entries from trash
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const result = await parseBody(req, bulkIdsSchema);
  if (!result.ok) return result.response;

  const { ids } = result.data;

  const [entryIds, updateResult] = await withUserTenantRls(
    session.user.id,
    () =>
      prisma.$transaction(async (tx) => {
        const entries = await tx.passwordEntry.findMany({
          where: {
            userId: session.user.id,
            id: { in: ids },
            deletedAt: { not: null },
          },
          select: { id: true },
        });
        const entryIds = entries.map((entry) => entry.id);
        const result = await tx.passwordEntry.updateMany({
          where: {
            userId: session.user.id,
            id: { in: entryIds },
            deletedAt: { not: null },
          },
          data: { deletedAt: null },
        });
        return [entryIds, result] as const;
      }),
  );

  const requestMeta = extractRequestMeta(req);

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.ENTRY_BULK_RESTORE,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    targetId: null,
    metadata: {
      bulk: true,
      operation: "restore",
      requestedCount: ids.length,
      restoredCount: updateResult.count,
      entryIds,
    },
    ...requestMeta,
  });

  logAuditBatch(
    entryIds.map((entryId) => ({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_RESTORE,
      userId: session.user.id,
      targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
      targetId: entryId,
      metadata: {
        source: "bulk-restore",
        parentAction: AUDIT_ACTION.ENTRY_BULK_RESTORE,
      },
      ...requestMeta,
    })),
  );

  return NextResponse.json({ success: true, restoredCount: updateResult.count });
}

export const POST = withRequestLog(handlePOST);
