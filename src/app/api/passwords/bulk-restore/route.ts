import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { errorResponse, unauthorized } from "@/lib/api-response";

interface BulkRestoreBody {
  ids: string[];
}

// POST /api/passwords/bulk-restore - Restore multiple entries from trash
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(API_ERROR.INVALID_JSON, 400);
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

  const MAX_BULK_IDS = 100;
  if (ids.length === 0 || ids.length > MAX_BULK_IDS) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
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

  // Re-fetch to get accurate list of actually restored entries
  const restoredEntries = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntry.findMany({
      where: {
        userId: session.user.id,
        id: { in: entryIds },
        deletedAt: null,
      },
      select: { id: true },
    }),
  );
  const restoredEntryIds = restoredEntries.map((e) => e.id);

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
      entryIds: restoredEntryIds,
    },
    ...requestMeta,
  });

  for (const entryId of restoredEntryIds) {
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
