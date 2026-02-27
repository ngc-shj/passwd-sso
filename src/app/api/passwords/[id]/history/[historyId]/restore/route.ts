import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { AUDIT_TARGET_TYPE, AUDIT_SCOPE, AUDIT_ACTION, AUDIT_METADATA_KEY } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";

// POST /api/passwords/[id]/history/[historyId]/restore - Restore a history version
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; historyId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { id, historyId } = await params;

  const entry = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntry.findUnique({
      where: { id },
    }),
  );

  if (!entry) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }
  if (entry.userId !== session.user.id) {
    return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
  }

  const history = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntryHistory.findUnique({
      where: { id: historyId },
    }),
  );

  if (!history || history.entryId !== id) {
    return NextResponse.json({ error: API_ERROR.HISTORY_NOT_FOUND }, { status: 404 });
  }

  // Snapshot current blob, then overwrite with history version
  await withUserTenantRls(session.user.id, async () =>
    prisma.$transaction(async (tx) => {
    // Save current as new history
    await tx.passwordEntryHistory.create({
      data: {
        entryId: id,
        encryptedBlob: entry.encryptedBlob,
        blobIv: entry.blobIv,
        blobAuthTag: entry.blobAuthTag,
        keyVersion: entry.keyVersion,
        aadVersion: entry.aadVersion,
      },
    });

    // Trim to max 20
    const all = await tx.passwordEntryHistory.findMany({
      where: { entryId: id },
      orderBy: [{ changedAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    if (all.length > 20) {
      await tx.passwordEntryHistory.deleteMany({
        where: { id: { in: all.slice(0, all.length - 20).map((r) => r.id) } },
      });
    }

    // Restore history version
    await tx.passwordEntry.update({
      where: { id },
      data: {
        encryptedBlob: history.encryptedBlob,
        blobIv: history.blobIv,
        blobAuthTag: history.blobAuthTag,
        keyVersion: history.keyVersion,
        aadVersion: history.aadVersion,
      },
    });
    }),
  );

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.ENTRY_HISTORY_RESTORE,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    targetId: id,
    metadata: {
      [AUDIT_METADATA_KEY.HISTORY_ID]: historyId,
      [AUDIT_METADATA_KEY.RESTORED_FROM_CHANGED_AT]: history.changedAt.toISOString(),
    },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}
