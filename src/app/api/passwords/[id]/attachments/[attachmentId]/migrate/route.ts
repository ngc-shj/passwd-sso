import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { withRequestLog } from "@/lib/http/with-request-log";
import { AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { errorResponse, notFound, unauthorized, rateLimited } from "@/lib/http/api-response";
import { migrateLimiter } from "@/lib/security/rate-limiters";
import {
  ATTACHMENT_BODY_BASE64_MAX,
  ATTACHMENT_MIGRATE_PAYLOAD_MAX,
  BASE64_RE,
  CEK_WRAP_BASE64_MAX,
} from "@/lib/validations/common";
import {
  applyAttachmentMigration,
  LegacyAttachmentInconsistentVersionError,
  LegacyMigrationNotApplicableError,
  LegacyBodyHashMismatchError,
} from "@/lib/vault/rotate-key-server";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string; attachmentId: string }>;
};

// PUT /api/passwords/[id]/attachments/[attachmentId]/migrate
// Migrates a single mode-0 (legacy) attachment to mode-2 (CEK indirection).
// Session-only: Bearer / SA / MCP tokens are rejected.
async function handlePUT(
  req: NextRequest,
  { params }: RouteContext,
) {
  // Session-only auth — reject Bearer / SA / MCP (I5.7)
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }
  const userId = session.user.id;

  const { id: entryId, attachmentId } = await params;

  // Rate limit per user
  const rl = await migrateLimiter.check(`rl:attachment_migrate:${userId}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  // Reject oversized JSON payloads early (memory-DoS guard) — mirror the
  // upload route's Content-Length pre-check before we buffer the body.
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const declaredSize = parseInt(contentLength, 10);
    if (!Number.isNaN(declaredSize) && declaredSize > ATTACHMENT_MIGRATE_PAYLOAD_MAX) {
      return errorResponse(API_ERROR.PAYLOAD_TOO_LARGE, 413);
    }
  }

  // Parse JSON body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(API_ERROR.INVALID_JSON, 400);
  }

  if (typeof body !== "object" || body === null) {
    return errorResponse(API_ERROR.INVALID_JSON, 400);
  }
  const b = body as Record<string, unknown>;

  const oldEncryptedDataHash = b["oldEncryptedDataHash"];
  const encryptedData = b["encryptedData"];
  const iv = b["iv"];
  const authTag = b["authTag"];
  const cekEncrypted = b["cekEncrypted"];
  const cekIv = b["cekIv"];
  const cekAuthTag = b["cekAuthTag"];
  const cekKeyVersion = b["cekKeyVersion"];
  const cekWrapAadVersion = b["cekWrapAadVersion"];

  // Field presence check
  if (
    typeof oldEncryptedDataHash !== "string" ||
    typeof encryptedData !== "string" ||
    typeof iv !== "string" ||
    typeof authTag !== "string" ||
    typeof cekEncrypted !== "string" ||
    typeof cekIv !== "string" ||
    typeof cekAuthTag !== "string" ||
    typeof cekKeyVersion !== "number" ||
    typeof cekWrapAadVersion !== "number"
  ) {
    return errorResponse(API_ERROR.MISSING_REQUIRED_FIELDS, 400);
  }

  // Validate hex formats
  if (!/^[0-9a-f]{64}$/.test(oldEncryptedDataHash)) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }
  if (!/^[0-9a-f]{24}$/.test(iv) || !/^[0-9a-f]{24}$/.test(cekIv)) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }
  if (!/^[0-9a-f]{32}$/.test(authTag) || !/^[0-9a-f]{32}$/.test(cekAuthTag)) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }
  if (!Number.isInteger(cekKeyVersion) || cekKeyVersion < 1) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }
  if (!Number.isInteger(cekWrapAadVersion) || cekWrapAadVersion < 1) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }
  // Cap the base64-encoded blobs so a malformed client cannot inflate the
  // JSON parse output. The Content-Length pre-check above bounds the wire
  // payload; these caps bound the post-parse strings.
  if (encryptedData.length > ATTACHMENT_BODY_BASE64_MAX) {
    return errorResponse(API_ERROR.FILE_TOO_LARGE, 400);
  }
  if (cekEncrypted.length > CEK_WRAP_BASE64_MAX) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }
  // Reject non-base64 characters before `Buffer.from(_, "base64")` silently
  // drops invalid bytes — both blobs are persisted verbatim into BYTEA
  // columns, so a malformed input would corrupt the row instead of failing
  // fast.
  if (!BASE64_RE.test(encryptedData) || !BASE64_RE.test(cekEncrypted)) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }

  let result: { encryptionMode: 2; fromKeyVersion: number | null };
  try {
    result = await withUserTenantRls(userId, async () =>
      prisma.$transaction(async (tx) => {
        // Advisory lock prevents concurrent migrations / rotations for the
        // same user. The user record is read INSIDE the lock so the
        // keyVersion equality check is not racy against a concurrent
        // rotation that bumped the keyVersion between request boundary and
        // lock acquisition.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}::text))`;

        const u = await tx.user.findUnique({
          where: { id: userId },
          select: { tenantId: true, keyVersion: true },
        });
        if (!u?.tenantId) {
          throw new Error("USER_NOT_FOUND");
        }
        // I5.6: cekKeyVersion must match the user's current keyVersion at
        // lock-acquisition time.
        if (cekKeyVersion !== u.keyVersion) {
          throw new LegacyAttachmentInconsistentVersionError();
        }

        return applyAttachmentMigration(tx, {
          userId,
          tenantId: u.tenantId,
          entryId,
          attachmentId,
          payload: {
            oldEncryptedDataHash,
            encryptedData,
            iv,
            authTag,
            cekEncrypted,
            cekIv,
            cekAuthTag,
            cekKeyVersion,
            cekWrapAadVersion,
          },
        });
      }),
    );
  } catch (err) {
    if (err instanceof LegacyAttachmentInconsistentVersionError) {
      return errorResponse(API_ERROR.ATTACHMENT_INCONSISTENT_VERSION, 409);
    }
    if (err instanceof LegacyMigrationNotApplicableError) {
      // No payload per S11
      return errorResponse(API_ERROR.LEGACY_MIGRATION_NOT_APPLICABLE, 409);
    }
    if (err instanceof LegacyBodyHashMismatchError) {
      // No payload per S11
      return errorResponse(API_ERROR.LEGACY_INTEGRITY_MISMATCH, 409);
    }
    if (err instanceof Error && (err.message === "NOT_FOUND" || err.message === "USER_NOT_FOUND")) {
      return notFound();
    }
    throw err;
  }

  await logAuditAsync({
    ...personalAuditBase(req, userId),
    action: AUDIT_ACTION.ATTACHMENT_LEGACY_MIGRATION,
    targetType: AUDIT_TARGET_TYPE.ATTACHMENT,
    targetId: attachmentId,
    metadata: {
      entryId,
      attachmentId,
      fromKeyVersion: result.fromKeyVersion,
      toKeyVersion: cekKeyVersion,
    },
  });

  return NextResponse.json({
    success: true,
    attachmentId,
    encryptionMode: result.encryptionMode,
  });
}

export const PUT = withRequestLog(handlePUT);
