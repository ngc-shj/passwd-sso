import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { requireOrgPermission, OrgAuthError } from "@/lib/org-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { AUDIT_TARGET_TYPE, AUDIT_SCOPE, AUDIT_ACTION, AUDIT_METADATA_KEY, TEAM_PERMISSION } from "@/lib/constants";

type Params = { params: Promise<{ teamId: string; id: string; historyId: string }> };

// POST /api/teams/[teamId]/passwords/[id]/history/[historyId]/restore
export async function POST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId: orgId, id, historyId } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, TEAM_PERMISSION.PASSWORD_UPDATE);
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const entry = await prisma.orgPasswordEntry.findUnique({
    where: { id },
  });

  if (!entry || entry.orgId !== orgId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  const history = await prisma.orgPasswordEntryHistory.findUnique({
    where: { id: historyId },
  });

  if (!history || history.entryId !== id) {
    return NextResponse.json({ error: API_ERROR.HISTORY_NOT_FOUND }, { status: 404 });
  }

  await prisma.$transaction(async (tx) => {
    // Snapshot current
    await tx.orgPasswordEntryHistory.create({
      data: {
        entryId: id,
        encryptedBlob: entry.encryptedBlob,
        blobIv: entry.blobIv,
        blobAuthTag: entry.blobAuthTag,
        aadVersion: entry.aadVersion,
        orgKeyVersion: entry.orgKeyVersion,
        changedById: session.user.id,
      },
    });

    // Trim to max 20
    const all = await tx.orgPasswordEntryHistory.findMany({
      where: { entryId: id },
      orderBy: [{ changedAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    if (all.length > 20) {
      await tx.orgPasswordEntryHistory.deleteMany({
        where: { id: { in: all.slice(0, all.length - 20).map((r) => r.id) } },
      });
    }

    // Restore: writes back history blob with its original orgKeyVersion.
    // If history.orgKeyVersion !== org.orgKeyVersion (e.g. after key rotation),
    // the client must detect the mismatch, decrypt with the old key via
    // GET /member-key?keyVersion=N, re-encrypt with the current key, and PUT.
    await tx.orgPasswordEntry.update({
      where: { id },
      data: {
        encryptedBlob: history.encryptedBlob,
        blobIv: history.blobIv,
        blobAuthTag: history.blobAuthTag,
        aadVersion: history.aadVersion,
        orgKeyVersion: history.orgKeyVersion,
        updatedById: session.user.id,
      },
    });
  });

  logAudit({
    scope: AUDIT_SCOPE.ORG,
    action: AUDIT_ACTION.ENTRY_HISTORY_RESTORE,
    userId: session.user.id,
    orgId,
    targetType: AUDIT_TARGET_TYPE.ORG_PASSWORD_ENTRY,
    targetId: id,
    metadata: {
      [AUDIT_METADATA_KEY.HISTORY_ID]: historyId,
      [AUDIT_METADATA_KEY.RESTORED_FROM_CHANGED_AT]: history.changedAt.toISOString(),
    },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}
