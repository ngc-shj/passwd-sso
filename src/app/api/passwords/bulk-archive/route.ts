import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { withRequestLog } from "@/lib/with-request-log";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { unauthorized } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";
import { bulkArchiveSchema } from "@/lib/validations";

// POST /api/passwords/bulk-archive - Archive multiple entries
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const result = await parseBody(req, bulkArchiveSchema);
  if (!result.ok) return result.response;

  const { ids, operation } = result.data;
  const toArchived = operation === "archive";

  const [entryIds, updateResult] = await withUserTenantRls(
    session.user.id,
    () =>
      prisma.$transaction(async (tx) => {
        const entries = await tx.passwordEntry.findMany({
          where: {
            userId: session.user.id,
            id: { in: ids },
            deletedAt: null,
            isArchived: !toArchived,
          },
          select: { id: true },
        });
        const entryIds = entries.map((entry) => entry.id);
        const result = await tx.passwordEntry.updateMany({
          where: {
            userId: session.user.id,
            id: { in: entryIds },
            deletedAt: null,
            isArchived: !toArchived,
          },
          data: { isArchived: toArchived },
        });
        return [entryIds, result] as const;
      }),
  );

  const requestMeta = extractRequestMeta(req);

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: toArchived
      ? AUDIT_ACTION.ENTRY_BULK_ARCHIVE
      : AUDIT_ACTION.ENTRY_BULK_UNARCHIVE,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    targetId: "bulk",
    metadata: {
      bulk: true,
      operation,
      requestedCount: ids.length,
      processedCount: updateResult.count,
      archivedCount: toArchived ? updateResult.count : 0,
      unarchivedCount: toArchived ? 0 : updateResult.count,
      entryIds,
    },
    ...requestMeta,
  });

  for (const entryId of entryIds) {
    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_UPDATE,
      userId: session.user.id,
      targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
      targetId: entryId,
      metadata: {
        source: "bulk-archive",
        parentAction: toArchived
          ? AUDIT_ACTION.ENTRY_BULK_ARCHIVE
          : AUDIT_ACTION.ENTRY_BULK_UNARCHIVE,
      },
      ...requestMeta,
    });
  }

  return NextResponse.json({
    success: true,
    operation,
    processedCount: updateResult.count,
    archivedCount: toArchived ? updateResult.count : 0,
    unarchivedCount: toArchived ? 0 : updateResult.count,
  });
}

export const POST = withRequestLog(handlePOST);
