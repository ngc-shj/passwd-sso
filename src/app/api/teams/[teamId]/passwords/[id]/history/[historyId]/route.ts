import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamMember } from "@/lib/auth/team-auth";
import { logAuditAsync, teamAuditBase } from "@/lib/audit/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, handleAuthError, notFound, rateLimited, unauthorized } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";
import { teamHistoryReencryptSchema } from "@/lib/validations";

type Params = { params: Promise<{ teamId: string; id: string; historyId: string }> };

const reencryptLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

// GET /api/teams/[teamId]/passwords/[id]/history/[historyId] — Return encrypted history blob (client decrypts)
async function handleGET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, id, historyId } = await params;

  try {
    await requireTeamMember(session.user.id, teamId, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const [entry, history] = await withTeamTenantRls(teamId, () =>
    Promise.all([
      prisma.teamPasswordEntry.findUnique({
        where: { id },
        select: { teamId: true, entryType: true },
      }),
      prisma.teamPasswordEntryHistory.findUnique({
        where: { id: historyId },
      }),
    ]),
  );

  if (!entry || entry.teamId !== teamId) {
    return notFound();
  }

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

  const rl = await reencryptLimiter.check(`rl:team_history_reencrypt:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const { teamId, id, historyId } = await params;

  try {
    await requireTeamMember(session.user.id, teamId, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const parsed = await parseBody(req, teamHistoryReencryptSchema);
  if (!parsed.ok) return parsed.response;

  const {
    encryptedBlob, blobIv, blobAuthTag,
    teamKeyVersion, itemKeyVersion,
    encryptedItemKey, itemKeyIv, itemKeyAuthTag,
    oldBlobHash,
  } = parsed.data;

  const [entry, history] = await withTeamTenantRls(teamId, () =>
    Promise.all([
      prisma.teamPasswordEntry.findUnique({
        where: { id },
        select: { teamId: true },
      }),
      prisma.teamPasswordEntryHistory.findUnique({
        where: { id: historyId },
      }),
    ]),
  );

  if (!entry || entry.teamId !== teamId) {
    return notFound();
  }

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

  await logAuditAsync({
    ...teamAuditBase(req, session.user.id, teamId),
    action: AUDIT_ACTION.ENTRY_HISTORY_REENCRYPT,
    targetType: AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
    targetId: id,
    metadata: {
      historyId,
      oldTeamKeyVersion: oldTeamKV,
      newTeamKeyVersion: teamKeyVersion,
      oldItemKeyVersion: oldItemKV,
      newItemKeyVersion: newItemKV,
    },
  });

  return NextResponse.json({ success: true });
}

export const GET = withRequestLog(handleGET);
export const PATCH = withRequestLog(handlePATCH);
