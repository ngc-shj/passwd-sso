import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireOrgMember, OrgAuthError } from "@/lib/org-auth";
import { API_ERROR } from "@/lib/api-error-codes";

type Params = { params: Promise<{ orgId: string; id: string }> };

// GET /api/orgs/[orgId]/passwords/[id]/history - List org entry history
export async function GET(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { orgId, id } = await params;

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
    select: { orgId: true },
  });

  if (!entry || entry.orgId !== orgId) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  const histories = await prisma.orgPasswordEntryHistory.findMany({
    where: { entryId: id },
    orderBy: { changedAt: "desc" },
    include: { changedBy: { select: { id: true, name: true, email: true } } },
  });

  return NextResponse.json(
    histories.map((h) => ({
      id: h.id,
      entryId: h.entryId,
      encryptedBlob: {
        ciphertext: h.encryptedBlob,
        iv: h.blobIv,
        authTag: h.blobAuthTag,
      },
      aadVersion: h.aadVersion,
      orgKeyVersion: h.orgKeyVersion,
      changedAt: h.changedAt,
      changedBy: h.changedBy,
    })),
  );
}
