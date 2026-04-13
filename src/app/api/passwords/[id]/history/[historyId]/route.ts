import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, rateLimited, forbidden, notFound, unauthorized } from "@/lib/api-response";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { createRateLimiter } from "@/lib/rate-limit";
import { withRequestLog } from "@/lib/with-request-log";
import { parseBody } from "@/lib/parse-body";
import { historyReencryptSchema } from "@/lib/validations";

type Params = { params: Promise<{ id: string; historyId: string }> };

const reencryptLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

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
    return forbidden();
  }

  if (!history || history.entryId !== id) {
    return errorResponse(API_ERROR.HISTORY_NOT_FOUND, 404);
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

// PATCH /api/passwords/[id]/history/[historyId] — re-encrypt history entry
async function handlePATCH(
  req: NextRequest,
  { params }: Params,
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const rl = await reencryptLimiter.check(`rl:history_reencrypt:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const { id, historyId } = await params;

  const parsed = await parseBody(req, historyReencryptSchema);
  if (!parsed.ok) return parsed.response;

  const { encryptedBlob, blobIv, blobAuthTag, keyVersion, oldBlobHash } = parsed.data;

  // Verify ownership and fetch history in parallel
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
    return forbidden();
  }

  if (!history || history.entryId !== id) {
    return errorResponse(API_ERROR.HISTORY_NOT_FOUND, 404);
  }

  // Prevent key version downgrade or same-version re-encryption
  if (keyVersion <= history.keyVersion) {
    return NextResponse.json(
      { error: "KEY_VERSION_NOT_NEWER" },
      { status: 400 },
    );
  }

  // Compare-and-swap: verify old blob hash
  const actualHash = createHash("sha256").update(history.encryptedBlob).digest("hex");
  if (oldBlobHash !== actualHash) {
    return NextResponse.json(
      { error: "BLOB_HASH_MISMATCH" },
      { status: 409 },
    );
  }

  // Atomic update with optimistic locking on keyVersion to prevent TOCTOU
  const result = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntryHistory.updateMany({
      where: { id: historyId, keyVersion: history.keyVersion },
      data: {
        encryptedBlob,
        blobIv,
        blobAuthTag,
        keyVersion,
      },
    }),
  );

  if (result.count === 0) {
    return NextResponse.json(
      { error: "BLOB_HASH_MISMATCH" },
      { status: 409 },
    );
  }

  const meta = extractRequestMeta(req);
  await logAuditAsync({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.ENTRY_HISTORY_REENCRYPT,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    targetId: id,
    metadata: {
      historyId,
      oldKeyVersion: history.keyVersion,
      newKeyVersion: keyVersion,
    },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  return NextResponse.json({ success: true });
}

export const GET = withRequestLog(handleGET);
export const PATCH = withRequestLog(handlePATCH);
