import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, forbidden, notFound, unauthorized } from "@/lib/api-response";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { createRateLimiter } from "@/lib/rate-limit";
import { withRequestLog } from "@/lib/with-request-log";

type Params = { params: Promise<{ id: string; historyId: string }> };

const reencryptLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

// Validate hex string of expected byte length
function isValidHex(value: string, byteLength: number): boolean {
  return value.length === byteLength * 2 && /^[0-9a-f]+$/i.test(value);
}

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

  const history = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntryHistory.findUnique({
      where: { id: historyId },
    }),
  );

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

  if (!(await reencryptLimiter.check(`rl:history_reencrypt:${session.user.id}`)).allowed) {
    return errorResponse(API_ERROR.RATE_LIMIT_EXCEEDED, 429);
  }

  const { id, historyId } = await params;

  const body = await req.json();
  const { encryptedBlob, blobIv, blobAuthTag, keyVersion, oldBlobHash } = body;

  // Validate required fields
  if (!encryptedBlob || !blobIv || !blobAuthTag || keyVersion == null || !oldBlobHash) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }

  // Validate blob format
  if (typeof encryptedBlob !== "string" || encryptedBlob.length === 0 || encryptedBlob.length > 1_000_000) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }
  if (typeof blobIv !== "string" || !isValidHex(blobIv, 12)) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }
  if (typeof blobAuthTag !== "string" || !isValidHex(blobAuthTag, 16)) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }
  if (typeof keyVersion !== "number" || !Number.isInteger(keyVersion)) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }
  if (typeof oldBlobHash !== "string" || !isValidHex(oldBlobHash, 32)) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }

  // Verify ownership
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

  const history = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntryHistory.findUnique({
      where: { id: historyId },
    }),
  );

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
  logAudit({
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
