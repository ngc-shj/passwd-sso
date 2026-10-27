import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, logAuditBulkAsync, personalAuditBase } from "@/lib/audit/audit";
import { withRequestLog } from "@/lib/http/with-request-log";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { createPersonalPasswordEntry } from "@/lib/services/personal-password-service";
import { withUserTenantRls } from "@/lib/tenant-context";
import { rateLimited, unauthorized, errorResponse } from "@/lib/http/api-response";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { KeyVersionMismatchError } from "@/lib/vault/key-version-guard";
import { attemptInSavepoint } from "@/lib/prisma/savepoint";
import { pgErrorCode } from "@/lib/prisma/prisma-error";
import { getLogger } from "@/lib/logger";

import { parseBody } from "@/lib/http/parse-body";
import { bulkImportSchema } from "@/lib/validations";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { FILENAME_MAX_LENGTH } from "@/lib/validations/common";
import { RATE_WINDOW_MS } from "@/lib/validations/common.server";

const bulkImportLimiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: 30 });

// POST /api/passwords/bulk-import - Bulk create password entries (E2E encrypted)
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }
  const userId = session.user.id;

  const rl = await bulkImportLimiter.check(`rl:passwords_bulk_import:${userId}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  const result = await parseBody(req, bulkImportSchema);
  if (!result.ok) return result.response;

  const { entries, sourceFilename } = result.data;

  const sanitizedFilename = sourceFilename
    ? sourceFilename
        .replace(/[\0\x01-\x1f\x7f-\x9f]/g, "")
        .replace(/[/\\]/g, "_")
        .trim()
        .slice(0, FILENAME_MAX_LENGTH) || undefined
    : undefined;

  const createdIds: string[] = [];
  let failedCount = 0;

  try {
    await withUserTenantRls(userId, async (tenantId) => {
      for (const entryData of entries) {
        // Each entry under its own savepoint: a statement the database
        // rejects (e.g. a duplicate client-supplied id) would otherwise abort
        // the whole transaction and turn the final COMMIT into a silent
        // ROLLBACK of every entry already counted as created.
        const attempt = await attemptInSavepoint(prisma, () =>
          createPersonalPasswordEntry(prisma, userId, tenantId, entryData),
        );
        if (attempt.ok) {
          if (attempt.value.ok) createdIds.push(attempt.value.entry.id);
          else failedCount++;
          continue;
        }
        // A stale keyVersion means the whole import is racing a rotation —
        // rethrow out of the tx so it fully rolls back (no partial
        // undecryptable rows) instead of being counted as a per-entry
        // failure. Every persisted entry's guard FOR SHARE is held until
        // commit; a rolled-back entry releases its own, but it wrote nothing
        // and the next entry's guard re-reads the version under a fresh lock.
        if (attempt.error instanceof KeyVersionMismatchError) throw attempt.error;
        // The SQLSTATE only: a Prisma error's message carries the query and its
        // bound parameters, i.e. this entry's ciphertext.
        getLogger().warn({ userId, code: pgErrorCode(attempt.error) }, "passwords.bulk_import.entry_failed");
        failedCount++;
      }
    });
  } catch (e) {
    if (e instanceof KeyVersionMismatchError) {
      return errorResponse(API_ERROR.KEY_VERSION_MISMATCH);
    }
    throw e;
  }

  const requestMeta = personalAuditBase(req, userId);

  await logAuditAsync({
    ...requestMeta,
    action: AUDIT_ACTION.ENTRY_BULK_IMPORT,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    // targetId omitted for bulk operations
    metadata: {
      bulk: true,
      requestedCount: entries.length,
      createdCount: createdIds.length,
      failedCount,
      ...(sanitizedFilename ? { filename: sanitizedFilename } : {}),
    },
  });

  await logAuditBulkAsync(
    createdIds.map((entryId) => ({
      ...requestMeta,
      action: AUDIT_ACTION.ENTRY_CREATE,
      targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
      targetId: entryId,
      metadata: {
        source: "bulk-import",
        parentAction: AUDIT_ACTION.ENTRY_BULK_IMPORT,
      },
    })),
  );

  return NextResponse.json(
    { success: true, importedCount: createdIds.length, failedCount },
    { status: 201 },
  );
}

export const POST = withRequestLog(handlePOST);
