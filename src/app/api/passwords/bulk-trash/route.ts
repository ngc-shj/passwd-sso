import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";

interface BulkTrashBody {
  ids: string[];
}

// POST /api/passwords/bulk-trash - Soft delete multiple entries (move to trash)
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

  const ids = Array.isArray((body as BulkTrashBody)?.ids)
    ? Array.from(new Set((body as BulkTrashBody).ids.filter((id) => typeof id === "string" && id.length > 0)))
    : [];

  if (ids.length === 0) {
    return NextResponse.json({ error: API_ERROR.VALIDATION_ERROR }, { status: 400 });
  }

  const entriesToTrash = await prisma.passwordEntry.findMany({
    where: {
      userId: session.user.id,
      id: { in: ids },
      deletedAt: null,
    },
    select: { id: true },
  });
  const entryIds = entriesToTrash.map((entry) => entry.id);

  const deletedAt = new Date();
  const result = await prisma.passwordEntry.updateMany({
    where: {
      userId: session.user.id,
      id: { in: entryIds },
      deletedAt: null,
    },
    data: {
      deletedAt,
    },
  });
  const movedEntries = await prisma.passwordEntry.findMany({
    where: {
      userId: session.user.id,
      id: { in: entryIds },
      deletedAt,
    },
    select: { id: true },
  });
  const movedEntryIds = movedEntries.map((entry) => entry.id);
  const requestMeta = extractRequestMeta(req);

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.ENTRY_BULK_DELETE,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    targetId: "bulk",
    metadata: {
      bulk: true,
      requestedCount: ids.length,
      movedCount: result.count,
      entryIds: movedEntryIds,
    },
    ...requestMeta,
  });

  for (const entryId of movedEntryIds) {
    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.ENTRY_DELETE,
      userId: session.user.id,
      targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
      targetId: entryId,
      metadata: {
        source: "bulk-trash",
        parentAction: AUDIT_ACTION.ENTRY_BULK_DELETE,
      },
      ...requestMeta,
    });
  }

  return NextResponse.json({ success: true, movedCount: result.count });
}
