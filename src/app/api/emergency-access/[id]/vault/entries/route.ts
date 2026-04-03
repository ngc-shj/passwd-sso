import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { EA_STATUS, AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { createRateLimiter } from "@/lib/rate-limit";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, rateLimited, notFound, unauthorized } from "@/lib/api-response";

const entriesLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

// GET /api/emergency-access/[id]/vault/entries — Fetch owner's encrypted entries
async function handleGET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const rl = await entriesLimiter.check(`rl:ea_vault_entries:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const { id } = await params;

  const grant = await withBypassRls(prisma, async () =>
    prisma.emergencyAccessGrant.findUnique({
      where: { id },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  if (!grant || grant.granteeId !== session.user.id) {
    return notFound();
  }

  if (grant.status !== EA_STATUS.ACTIVATED) {
    return errorResponse(API_ERROR.NOT_ACTIVATED, 403);
  }

  // Fetch all non-deleted entries for the owner
  const entries = await withBypassRls(prisma, async () =>
    prisma.passwordEntry.findMany({
      where: {
        userId: grant.ownerId,
        deletedAt: null,
      },
      select: {
        id: true,
        encryptedBlob: true,
        blobIv: true,
        blobAuthTag: true,
        encryptedOverview: true,
        overviewIv: true,
        overviewAuthTag: true,
        keyVersion: true,
        aadVersion: true,
        entryType: true,
        isFavorite: true,
        isArchived: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.EMERGENCY_VAULT_ACCESS,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
    targetId: id,
    metadata: { ownerId: grant.ownerId, granteeId: grant.granteeId, entryCount: entries.length },
    ...extractRequestMeta(req),
  });

  return NextResponse.json(entries);
}

export const GET = withRequestLog(handleGET);
