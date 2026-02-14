import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";

interface BulkArchiveBody {
  ids: string[];
}

// POST /api/passwords/bulk-archive - Archive multiple entries
export async function POST(req: NextRequest) {
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

  if (ids.length === 0) {
    return NextResponse.json({ error: API_ERROR.VALIDATION_ERROR }, { status: 400 });
  }

  const entriesToArchive = await prisma.passwordEntry.findMany({
    where: {
      userId: session.user.id,
      id: { in: ids },
      deletedAt: null,
      isArchived: false,
    },
    select: { id: true },
  });
  const entryIds = entriesToArchive.map((entry) => entry.id);

  const result = await prisma.passwordEntry.updateMany({
    where: {
      userId: session.user.id,
      id: { in: entryIds },
      deletedAt: null,
      isArchived: false,
    },
    data: {
      isArchived: true,
    },
  });

  const requestMeta = extractRequestMeta(req);

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.ENTRY_BULK_ARCHIVE,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    targetId: "bulk",
    metadata: {
      bulk: true,
      operation: "archive",
      requestedCount: ids.length,
      archivedCount: result.count,
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
        parentAction: AUDIT_ACTION.ENTRY_BULK_ARCHIVE,
      },
      ...requestMeta,
    });
  }

  return NextResponse.json({ success: true, archivedCount: result.count });
}
