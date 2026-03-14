import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { withRequestLog } from "@/lib/with-request-log";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { unauthorized } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";
import { bulkIdsSchema } from "@/lib/validations";

// POST /api/passwords/bulk-trash - Soft delete multiple entries (move to trash)
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const result = await parseBody(req, bulkIdsSchema);
  if (!result.ok) return result.response;

  const { ids } = result.data;

  const entriesToTrash = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntry.findMany({
      where: {
        userId: session.user.id,
        id: { in: ids },
        deletedAt: null,
      },
      select: { id: true },
    }),
  );
  const entryIds = entriesToTrash.map((entry) => entry.id);

  const deletedAt = new Date();
  const updateResult = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntry.updateMany({
      where: {
        userId: session.user.id,
        id: { in: entryIds },
        deletedAt: null,
      },
      data: {
        deletedAt,
      },
    }),
  );
  const movedEntries = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntry.findMany({
      where: {
        userId: session.user.id,
        id: { in: entryIds },
        deletedAt,
      },
      select: { id: true },
    }),
  );
  const movedEntryIds = movedEntries.map((entry) => entry.id);
  const requestMeta = extractRequestMeta(req);

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.ENTRY_BULK_TRASH,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    targetId: "bulk",
    metadata: {
      bulk: true,
      requestedCount: ids.length,
      movedCount: updateResult.count,
      entryIds: movedEntryIds,
    },
    ...requestMeta,
  });

  for (const entryId of movedEntryIds) {
    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_TRASH,
      userId: session.user.id,
      targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
      targetId: entryId,
      metadata: {
        source: "bulk-trash",
        parentAction: AUDIT_ACTION.ENTRY_BULK_TRASH,
      },
      ...requestMeta,
    });
  }

  return NextResponse.json({ success: true, movedCount: updateResult.count });
}

export const POST = withRequestLog(handlePOST);
