import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, notFound, unauthorized } from "@/lib/http/api-response";
import { AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_METADATA_KEY } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/http/with-request-log";
import { assertCurrentKeyVersion, KeyVersionMismatchError } from "@/lib/vault/key-version-guard";

// POST /api/passwords/[id]/history/[historyId]/restore - Restore a history version
async function handlePOST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; historyId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { id, historyId } = await params;

  const entry = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntry.findUnique({
      where: { id },
      select: {
        userId: true,
        tenantId: true,
      },
    }),
  );

  if (!entry) {
    return notFound();
  }
  if (entry.userId !== session.user.id) {
    // A01-4: 403 vs 404 difference leaks "ID exists in tenant" oracle to
    // attacker. RLS should already null this branch; defense-in-depth.
    return notFound();
  }

  const history = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntryHistory.findUnique({
      where: { id: historyId },
      select: {
        entryId: true,
        encryptedBlob: true,
        blobIv: true,
        blobAuthTag: true,
        keyVersion: true,
        aadVersion: true,
        changedAt: true,
      },
    }),
  );

  if (!history || history.entryId !== id) {
    return errorResponse(API_ERROR.HISTORY_NOT_FOUND);
  }

  // Row type for the FOR UPDATE snapshot read (personal password_entries).
  type PersonalBlobRow = {
    encrypted_blob: string;
    blob_iv: string;
    blob_auth_tag: string;
    key_version: number;
    aad_version: number;
  };

  // Snapshot current blob, then overwrite with history version. The snapshot
  // is re-read under FOR UPDATE INSIDE the tx (not the stale out-of-tx `entry`
  // read above) so it always reflects the immediately-preceding committed
  // blob, closing the rotation-between-the-two-pre-tx-reads window.
  let restored: true | null;
  try {
    restored = await withUserTenantRls(session.user.id, async () =>
      prisma.$transaction(async (tx) => {
        // Lock order: users FOR SHARE first, then the entry FOR UPDATE.
        await assertCurrentKeyVersion(tx, session.user.id, history.keyVersion);

        const [cur] = await tx.$queryRaw<PersonalBlobRow[]>`
          SELECT encrypted_blob, blob_iv, blob_auth_tag, key_version, aad_version
          FROM password_entries
          WHERE id = ${id}::uuid
          FOR UPDATE
        `;
        // Entry may be concurrently deleted between the early read and this lock.
        if (!cur) return null;

        // Save current (locked) blob as new history
        await tx.passwordEntryHistory.create({
          data: {
            entryId: id,
            tenantId: entry.tenantId,
            encryptedBlob: cur.encrypted_blob,
            blobIv: cur.blob_iv,
            blobAuthTag: cur.blob_auth_tag,
            keyVersion: cur.key_version,
            aadVersion: cur.aad_version,
          },
        });

        // Trim to max 20
        const all = await tx.passwordEntryHistory.findMany({
          where: { entryId: id },
          orderBy: [{ changedAt: "asc" }, { id: "asc" }],
          select: { id: true },
        });
        if (all.length > 20) {
          await tx.passwordEntryHistory.deleteMany({
            where: { entryId: id, id: { in: all.slice(0, all.length - 20).map((r) => r.id) } },
          });
        }

        // Restore history version
        await tx.passwordEntry.update({
          where: { id, userId: session.user.id },
          data: {
            encryptedBlob: history.encryptedBlob,
            blobIv: history.blobIv,
            blobAuthTag: history.blobAuthTag,
            keyVersion: history.keyVersion,
            aadVersion: history.aadVersion,
          },
        });

        return true;
      }),
    );
  } catch (e) {
    if (e instanceof KeyVersionMismatchError) {
      return errorResponse(API_ERROR.KEY_VERSION_MISMATCH);
    }
    throw e;
  }

  // Null sentinel: the entry was concurrently deleted between the early
  // findUnique and the FOR UPDATE lock.
  if (!restored) return notFound();

  await logAuditAsync({
    ...personalAuditBase(req, session.user.id),
    action: AUDIT_ACTION.ENTRY_HISTORY_RESTORE,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    targetId: id,
    metadata: {
      [AUDIT_METADATA_KEY.HISTORY_ID]: historyId,
      [AUDIT_METADATA_KEY.RESTORED_FROM_CHANGED_AT]: history.changedAt.toISOString(),
    },
  });

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
