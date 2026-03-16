import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { unauthorized, notFound, forbidden } from "@/lib/api-response";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";

// GET /api/passwords/[id]/history - List entry history (encrypted blobs)
async function handleGET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { id } = await params;

  const entry = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntry.findUnique({
      where: { id },
      select: { userId: true },
    }),
  );

  if (!entry) {
    return notFound();
  }
  if (entry.userId !== session.user.id) {
    return forbidden();
  }

  const histories = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntryHistory.findMany({
      where: { entryId: id },
      orderBy: { changedAt: "desc" },
      take: 20,
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

export const GET = withRequestLog(handleGET);
