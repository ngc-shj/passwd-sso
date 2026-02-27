import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";

interface BulkArchiveBody {
  ids: string[];
  operation?: "archive" | "unarchive";
}

// POST /api/passwords/bulk-archive - Archive multiple entries
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

  const ids = Array.isArray((body as BulkArchiveBody)?.ids)
    ? Array.from(
        new Set(
          (body as BulkArchiveBody).ids.filter(
            (id) => typeof id === "string" && id.length > 0
          )
        )
      )
    : [];
  const operation =
    (body as BulkArchiveBody)?.operation === "unarchive"
      ? "unarchive"
      : "archive";
  const toArchived = operation === "archive";

  if (ids.length === 0) {
    return NextResponse.json({ error: API_ERROR.VALIDATION_ERROR }, { status: 400 });
  }

  const entriesToProcess = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntry.findMany({
      where: {
        userId: session.user.id,
        id: { in: ids },
        deletedAt: null,
        isArchived: !toArchived,
      },
      select: { id: true },
    }),
  );
  const entryIds = entriesToProcess.map((entry) => entry.id);

  const result = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntry.updateMany({
      where: {
        userId: session.user.id,
        id: { in: entryIds },
        deletedAt: null,
        isArchived: !toArchived,
      },
      data: {
        isArchived: toArchived,
      },
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
      processedCount: result.count,
      archivedCount: toArchived ? result.count : 0,
      unarchivedCount: toArchived ? 0 : result.count,
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
    processedCount: result.count,
    archivedCount: toArchived ? result.count : 0,
    unarchivedCount: toArchived ? 0 : result.count,
  });
}

export const POST = withRequestLog(handlePOST);
