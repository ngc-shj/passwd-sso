import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamMember, TeamAuthError } from "@/lib/team-auth";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { createRateLimiter } from "@/lib/rate-limit";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, notFound, unauthorized } from "@/lib/api-response";

type Params = { params: Promise<{ teamId: string; id: string; historyId: string }> };

const reencryptLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

function isValidHex(value: string, byteLength: number): boolean {
  return value.length === byteLength * 2 && /^[0-9a-f]+$/i.test(value);
}

// GET /api/teams/[teamId]/passwords/[id]/history/[historyId] — Return encrypted history blob (client decrypts)
async function handleGET(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, id, historyId } = await params;

  try {
    await requireTeamMember(session.user.id, teamId);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
  }

  const entry = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findUnique({
      where: { id },
      select: { teamId: true, entryType: true },
    }),
  );

  if (!entry || entry.teamId !== teamId) {
    return notFound();
  }

  const history = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntryHistory.findUnique({
      where: { id: historyId },
    }),
  );

  if (!history || history.entryId !== id) {
    return errorResponse(API_ERROR.HISTORY_NOT_FOUND, 404);
  }

  return NextResponse.json({
    id: history.id,
    entryId: history.entryId,
    changedAt: history.changedAt,
    entryType: entry.entryType,
    encryptedBlob: history.encryptedBlob,
    blobIv: history.blobIv,
    blobAuthTag: history.blobAuthTag,
    aadVersion: history.aadVersion,
    teamKeyVersion: history.teamKeyVersion,
    itemKeyVersion: history.itemKeyVersion,
    encryptedItemKey: history.encryptedItemKey,
    itemKeyIv: history.itemKeyIv,
    itemKeyAuthTag: history.itemKeyAuthTag,
  });
}

// PATCH /api/teams/[teamId]/passwords/[id]/history/[historyId] — re-encrypt team history entry
async function handlePATCH(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  if (!(await reencryptLimiter.check(`rl:team_history_reencrypt:${session.user.id}`)).allowed) {
    return errorResponse(API_ERROR.RATE_LIMIT_EXCEEDED, 429);
  }

  const { teamId, id, historyId } = await params;

  try {
    await requireTeamMember(session.user.id, teamId);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
  }

  const body = await req.json();
  const {
    encryptedBlob, blobIv, blobAuthTag,
    teamKeyVersion, itemKeyVersion,
    encryptedItemKey, itemKeyIv, itemKeyAuthTag,
    oldBlobHash,
  } = body;

  // Validate required fields
  if (!encryptedBlob || !blobIv || !blobAuthTag || teamKeyVersion == null || !oldBlobHash) {
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

  // Validate optional itemKey fields when provided
  if (itemKeyIv != null && (typeof itemKeyIv !== "string" || !isValidHex(itemKeyIv, 12))) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }
  if (itemKeyAuthTag != null && (typeof itemKeyAuthTag !== "string" || !isValidHex(itemKeyAuthTag, 16))) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }
  if (typeof oldBlobHash !== "string" || !isValidHex(oldBlobHash, 32)) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }

  const entry = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findUnique({
      where: { id },
      select: { teamId: true },
    }),
  );

  if (!entry || entry.teamId !== teamId) {
    return notFound();
  }

  const history = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntryHistory.findUnique({
      where: { id: historyId },
    }),
  );

  if (!history || history.entryId !== id) {
    return errorResponse(API_ERROR.HISTORY_NOT_FOUND, 404);
  }

  // Dual key version validation: at least one must be newer
  const oldTeamKV = history.teamKeyVersion;
  const oldItemKV = history.itemKeyVersion ?? 0;
  const newItemKV = itemKeyVersion ?? 0;

  if (!(teamKeyVersion > oldTeamKV || (teamKeyVersion >= oldTeamKV && newItemKV > oldItemKV))) {
    return NextResponse.json(
      { error: "KEY_VERSION_NOT_NEWER" },
      { status: 400 },
    );
  }

  // Compare-and-swap
  const actualHash = createHash("sha256").update(history.encryptedBlob).digest("hex");
  if (oldBlobHash !== actualHash) {
    return NextResponse.json(
      { error: "BLOB_HASH_MISMATCH" },
      { status: 409 },
    );
  }

  // Build update data
  const updateData: Record<string, unknown> = {
    encryptedBlob,
    blobIv,
    blobAuthTag,
    teamKeyVersion,
  };
  if (itemKeyVersion != null) updateData.itemKeyVersion = itemKeyVersion;
  if (encryptedItemKey != null) updateData.encryptedItemKey = encryptedItemKey;
  if (itemKeyIv != null) updateData.itemKeyIv = itemKeyIv;
  if (itemKeyAuthTag != null) updateData.itemKeyAuthTag = itemKeyAuthTag;

  // Atomic update with optimistic locking on teamKeyVersion to prevent TOCTOU
  const result = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntryHistory.updateMany({
      where: { id: historyId, teamKeyVersion: history.teamKeyVersion },
      data: updateData,
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
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.ENTRY_HISTORY_REENCRYPT,
    userId: session.user.id,
    teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
    targetId: id,
    metadata: {
      historyId,
      oldTeamKeyVersion: oldTeamKV,
      newTeamKeyVersion: teamKeyVersion,
      oldItemKeyVersion: oldItemKV,
      newItemKeyVersion: newItemKV,
    },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  return NextResponse.json({ success: true });
}

export const GET = withRequestLog(handleGET);
export const PATCH = withRequestLog(handlePATCH);
