import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, logAuditBulkAsync, personalAuditBase } from "@/lib/audit/audit";
import { withRequestLog } from "@/lib/http/with-request-log";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { unauthorized } from "@/lib/http/api-response";
import { parseBody } from "@/lib/http/parse-body";
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

  const requestMeta = personalAuditBase(req, session.user.id);

  await logAuditAsync({
    ...requestMeta,
    action: AUDIT_ACTION.ENTRY_BULK_RESTORE,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    // targetId omitted for bulk operations
    metadata: {
      bulk: true,
      operation: "restore",
      requestedCount: ids.length,
      restoredCount: updateResult.count,
      entryIds,
    },
  });

  await logAuditBulkAsync(
    entryIds.map((entryId) => ({
      ...requestMeta,
      action: AUDIT_ACTION.ENTRY_RESTORE,
      targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
      targetId: entryId,
      metadata: {
        source: "bulk-restore",
        parentAction: AUDIT_ACTION.ENTRY_BULK_RESTORE,
      },
    })),
  );

  return NextResponse.json({ success: true, restoredCount: updateResult.count });
}

export const POST = withRequestLog(handlePOST);
