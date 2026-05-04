import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { withRequestLog } from "@/lib/http/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import { rateLimited, unauthorized } from "@/lib/http/api-response";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { ATTACHMENT_MANIFEST_CAP } from "@/lib/validations/common";

export const runtime = "nodejs";

// Same config as rotateLimiter in parent route — shared key space ensures
// the two endpoints count against the same budget per user.
const rotateLimiter = createRateLimiter({ windowMs: 15 * MS_PER_MINUTE, max: 3 });

/**
 * GET /api/vault/rotate-key/data
 * Bulk-fetch all personal vault data needed by the client before key rotation.
 * Returns all PasswordEntry rows (active + trash) and all PasswordEntryHistory
 * rows for the authenticated user, plus ECDH private key fields, mode-2
 * attachment CEK data for rewrapping, and mode-0 attachment IDs for migration.
 */
async function handleGET(_request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const rl = await rotateLimiter.check(`rl:vault_rotate:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const userId = session.user.id;

  const [entries, historyEntries, user, mode2AttachmentRows, mode0CandidateRows] =
    await withUserTenantRls(
      userId,
      async () =>
        Promise.all([
          prisma.passwordEntry.findMany({
            where: { userId },
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
            },
          }),
          prisma.passwordEntryHistory.findMany({
            where: { entry: { userId } },
            select: {
              id: true,
              entryId: true,
              encryptedBlob: true,
              blobIv: true,
              blobAuthTag: true,
              keyVersion: true,
              aadVersion: true,
            },
          }),
          prisma.user.findUnique({
            where: { id: userId },
            select: {
              encryptedEcdhPrivateKey: true,
              ecdhPrivateKeyIv: true,
              ecdhPrivateKeyAuthTag: true,
            },
          }),
          // Mode-2 attachments: CEK data for rewrapping during rotation.
          prisma.attachment.findMany({
            where: { passwordEntry: { userId }, encryptionMode: 2 },
            select: {
              id: true,
              passwordEntryId: true,
              cekEncrypted: true,
              cekIv: true,
              cekAuthTag: true,
              cekKeyVersion: true,
              cekWrapAadVersion: true,
            },
          }),
          // Mode-0 attachments: client must migrate these before rotation.
          // entryId is required so the client can call /api/passwords/{entryId}/attachments/{id}
          // and build the data AAD = buildAttachmentAAD(entryId, attachmentId).
          // Over-fetch by 1 to detect overflow without a separate count query.
          prisma.attachment.findMany({
            where: { passwordEntry: { userId }, encryptionMode: 0 },
            select: { id: true, passwordEntryId: true },
            take: ATTACHMENT_MANIFEST_CAP + 1,
          }),
        ]),
    );

  const ecdhPrivateKey =
    user?.encryptedEcdhPrivateKey != null
      ? {
          encryptedEcdhPrivateKey: user.encryptedEcdhPrivateKey,
          ecdhPrivateKeyIv: user.ecdhPrivateKeyIv,
          ecdhPrivateKeyAuthTag: user.ecdhPrivateKeyAuthTag,
        }
      : null;

  // Convert cekEncrypted Bytes to base64 string for the response.
  const mode2Attachments = mode2AttachmentRows.map((row) => ({
    id: row.id,
    entryId: row.passwordEntryId,
    cekEncrypted: row.cekEncrypted != null
      ? Buffer.from(row.cekEncrypted).toString("base64")
      : null,
    cekIv: row.cekIv,
    cekAuthTag: row.cekAuthTag,
    cekKeyVersion: row.cekKeyVersion,
    cekWrapAadVersion: row.cekWrapAadVersion,
  }));

  const mode0AttachmentsOverflow = mode0CandidateRows.length > ATTACHMENT_MANIFEST_CAP;
  // Filter out rows where passwordEntryId is null (defensive — mode-0 personal
  // attachments always have it, but the schema permits null for team-attachment
  // rows that mode-0 should not include via the where-clause).
  const mode0Attachments = mode0CandidateRows
    .slice(0, ATTACHMENT_MANIFEST_CAP)
    .filter((r): r is { id: string; passwordEntryId: string } => r.passwordEntryId !== null)
    .map((r) => ({ id: r.id, entryId: r.passwordEntryId }));

  return NextResponse.json({
    entries,
    historyEntries,
    ecdhPrivateKey,
    mode2Attachments,
    mode0Attachments,
    mode0AttachmentsOverflow,
  });
}

export const GET = withRequestLog(handleGET);
