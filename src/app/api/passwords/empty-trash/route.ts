import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, logAuditBulkAsync, personalAuditBase } from "@/lib/audit/audit";
import { withRequestLog } from "@/lib/with-request-log";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { unauthorized } from "@/lib/api-response";

// POST /api/passwords/empty-trash - Permanently delete all entries in trash
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  // Atomic findMany + deleteMany to prevent TOCTOU race
  const { entryIds, deletedCount } = await withUserTenantRls(session.user.id, async (): Promise<{ entryIds: string[]; deletedCount: number }> => {
    const [entries, result] = await prisma.$transaction(async (tx) => {
      const found = await tx.passwordEntry.findMany({
        where: { userId: session.user.id, deletedAt: { not: null } },
        select: { id: true },
      });
      const ids = found.map((e) => e.id);
      const deleted = await tx.passwordEntry.deleteMany({
        where: { userId: session.user.id, id: { in: ids }, deletedAt: { not: null } },
      });
      return [found, deleted] as const;
    });
    return { entryIds: entries.map((e) => e.id), deletedCount: result.count };
  });

  const requestMeta = personalAuditBase(req, session.user.id);

  await logAuditAsync({
    ...requestMeta,
    action: AUDIT_ACTION.ENTRY_EMPTY_TRASH,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    targetId: "trash",
    metadata: {
      operation: "empty-trash",
      deletedCount: deletedCount,
      entryIds,
    },
  });

  await logAuditBulkAsync(
    entryIds.map((entryId) => ({
      ...requestMeta,
      action: AUDIT_ACTION.ENTRY_PERMANENT_DELETE,
      targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
      targetId: entryId,
      metadata: {
        source: "empty-trash",
        parentAction: AUDIT_ACTION.ENTRY_EMPTY_TRASH,
      },
    })),
  );

  return NextResponse.json({ success: true, deletedCount: deletedCount });
}

export const POST = withRequestLog(handlePOST);
