import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, logAuditBulkAsync, personalAuditBase } from "@/lib/audit/audit";
import { withRequestLog } from "@/lib/http/with-request-log";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { createPersonalPasswordEntry } from "@/lib/services/personal-password-service";
import { withUserTenantRls } from "@/lib/tenant-context";
import { rateLimited, unauthorized } from "@/lib/http/api-response";

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

  await withUserTenantRls(userId, async (tenantId) => {
    for (const entryData of entries) {
      try {
        const res = await createPersonalPasswordEntry(prisma, userId, tenantId, entryData);
        if (res.ok) createdIds.push(res.entry.id);
        else failedCount++;
      } catch {
        failedCount++;
      }
    }
  });

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
