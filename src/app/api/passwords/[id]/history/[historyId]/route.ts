import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, notFound, unauthorized } from "@/lib/http/api-response";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/http/with-request-log";

type Params = { params: Promise<{ id: string; historyId: string }> };

// GET /api/passwords/[id]/history/[historyId] — individual history entry
async function handleGET(
  _req: NextRequest,
  { params }: Params,
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { id, historyId } = await params;

  const [entry, history] = await withUserTenantRls(session.user.id, () =>
    Promise.all([
      prisma.passwordEntry.findUnique({
        where: { id },
        select: { userId: true },
      }),
      prisma.passwordEntryHistory.findUnique({
        where: { id: historyId },
      }),
    ]),
  );

  if (!entry) {
    return notFound();
  }
  if (entry.userId !== session.user.id) {
    // A01-4: collapse 403 → 404 to remove existence oracle.
    return notFound();
  }

  if (!history || history.entryId !== id) {
    return errorResponse(API_ERROR.HISTORY_NOT_FOUND);
  }

  return NextResponse.json({
    id: history.id,
    entryId: history.entryId,
    encryptedBlob: {
      ciphertext: history.encryptedBlob,
      iv: history.blobIv,
      authTag: history.blobAuthTag,
    },
    keyVersion: history.keyVersion,
    aadVersion: history.aadVersion,
    changedAt: history.changedAt,
  });
}

export const GET = withRequestLog(handleGET);
