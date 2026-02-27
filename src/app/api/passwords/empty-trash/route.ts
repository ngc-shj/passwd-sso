import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";

// POST /api/passwords/empty-trash - Permanently delete all entries in trash
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const entries = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntry.findMany({
      where: {
        userId: session.user.id,
        deletedAt: { not: null },
      },
      select: { id: true },
    }),
  );
  const entryIds = entries.map((entry) => entry.id);

  const result = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntry.deleteMany({
      where: {
        userId: session.user.id,
        id: { in: entryIds },
        deletedAt: { not: null },
      },
    }),
  );

  const requestMeta = extractRequestMeta(req);

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.ENTRY_EMPTY_TRASH,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    targetId: "trash",
    metadata: {
      operation: "empty-trash",
      deletedCount: result.count,
      entryIds,
    },
    ...requestMeta,
  });

  for (const entryId of entryIds) {
    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_PERMANENT_DELETE,
      userId: session.user.id,
      targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
      targetId: entryId,
      metadata: {
        source: "empty-trash",
        parentAction: AUDIT_ACTION.ENTRY_EMPTY_TRASH,
      },
      ...requestMeta,
    });
  }

  return NextResponse.json({ success: true, deletedCount: result.count });
}

export const POST = withRequestLog(handlePOST);
