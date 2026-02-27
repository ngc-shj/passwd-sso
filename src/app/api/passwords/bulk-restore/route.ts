import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";

interface BulkRestoreBody {
  ids: string[];
}

// POST /api/passwords/bulk-restore - Restore multiple entries from trash
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const ids = Array.isArray((body as BulkRestoreBody)?.ids)
    ? Array.from(
        new Set(
          (body as BulkRestoreBody).ids.filter(
            (id) => typeof id === "string" && id.length > 0
          )
        )
      )
    : [];

  if (ids.length === 0) {
    return NextResponse.json({ error: API_ERROR.VALIDATION_ERROR }, { status: 400 });
  }

  const entriesToRestore = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntry.findMany({
      where: {
        userId: session.user.id,
        id: { in: ids },
        deletedAt: { not: null },
      },
      select: { id: true },
    }),
  );
  const entryIds = entriesToRestore.map((entry) => entry.id);

  const result = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntry.updateMany({
      where: {
        userId: session.user.id,
        id: { in: entryIds },
        deletedAt: { not: null },
      },
      data: {
        deletedAt: null,
      },
    }),
  );

  const requestMeta = extractRequestMeta(req);

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.ENTRY_BULK_RESTORE,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    targetId: "bulk",
    metadata: {
      bulk: true,
      operation: "restore",
      requestedCount: ids.length,
      restoredCount: result.count,
      entryIds,
    },
    ...requestMeta,
  });

  for (const entryId of entryIds) {
    logAudit({
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
    });
  }

  return NextResponse.json({ success: true, restoredCount: result.count });
}

export const POST = withRequestLog(handlePOST);
