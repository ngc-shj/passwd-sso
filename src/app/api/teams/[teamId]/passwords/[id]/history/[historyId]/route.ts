import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireOrgMember, OrgAuthError } from "@/lib/org-auth";
import { API_ERROR } from "@/lib/api-error-codes";

type Params = { params: Promise<{ teamId: string; id: string; historyId: string }> };

// GET /api/teams/[teamId]/passwords/[id]/history/[historyId] — Return encrypted history blob (client decrypts)
export async function GET(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId: orgId, id, historyId } = await params;

  try {
    await requireOrgMember(session.user.id, orgId);
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const entry = await prisma.orgPasswordEntry.findUnique({
    where: { id },
    select: { orgId: true, entryType: true },
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

  return NextResponse.json({
    id: history.id,
    entryId: history.entryId,
    changedAt: history.changedAt,
    entryType: entry.entryType,
    encryptedBlob: history.encryptedBlob,
    blobIv: history.blobIv,
    blobAuthTag: history.blobAuthTag,
    aadVersion: history.aadVersion,
    orgKeyVersion: history.orgKeyVersion,
  });
}
