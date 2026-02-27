import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { withUserTenantRls } from "@/lib/tenant-context";

// GET /api/passwords/[id]/history - List entry history (encrypted blobs)
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { id } = await params;

  const entry = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntry.findUnique({
      where: { id },
      select: { userId: true },
    }),
  );

  if (!entry) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }
  if (entry.userId !== session.user.id) {
    return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
  }

  const histories = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntryHistory.findMany({
      where: { entryId: id },
      orderBy: { changedAt: "desc" },
    }),
  );

  return NextResponse.json(
    histories.map((h) => ({
      id: h.id,
      entryId: h.entryId,
      encryptedBlob: {
        ciphertext: h.encryptedBlob,
        iv: h.blobIv,
        authTag: h.blobAuthTag,
      },
      keyVersion: h.keyVersion,
      aadVersion: h.aadVersion,
      changedAt: h.changedAt,
    })),
  );
}
