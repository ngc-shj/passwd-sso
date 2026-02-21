import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireOrgMember, OrgAuthError } from "@/lib/org-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { unwrapOrgKey, decryptServerData } from "@/lib/crypto-server";
import { buildOrgEntryAAD } from "@/lib/crypto-aad";

type Params = { params: Promise<{ orgId: string; id: string; historyId: string }> };

// GET /api/orgs/[orgId]/passwords/[id]/history/[historyId] — Decrypt a single history version
export async function GET(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { orgId, id, historyId } = await params;

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
    include: {
      org: {
        select: {
          encryptedOrgKey: true,
          orgKeyIv: true,
          orgKeyAuthTag: true,
          masterKeyVersion: true,
        },
      },
    },
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

  const orgKey = unwrapOrgKey({
    ciphertext: entry.org.encryptedOrgKey,
    iv: entry.org.orgKeyIv,
    authTag: entry.org.orgKeyAuthTag,
  }, entry.org.masterKeyVersion);

  const aad = history.aadVersion >= 1
    ? Buffer.from(buildOrgEntryAAD(orgId, id, "blob"))
    : undefined;

  let blob: Record<string, unknown>;
  try {
    blob = JSON.parse(
      decryptServerData(
        {
          ciphertext: history.encryptedBlob,
          iv: history.blobIv,
          authTag: history.blobAuthTag,
        },
        orgKey,
        aad
      )
    );
  } catch {
    return NextResponse.json(
      { error: API_ERROR.DECRYPT_FAILED },
      { status: 500 }
    );
  }

  return NextResponse.json({
    id: history.id,
    entryId: history.entryId,
    changedAt: history.changedAt,
    entryType: entry.entryType,
    ...blob,
  });
}
