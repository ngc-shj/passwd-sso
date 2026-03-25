import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/rate-limit";
import { withRequestLog } from "@/lib/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import { rateLimited, unauthorized } from "@/lib/api-response";

export const runtime = "nodejs";

// Same config as rotateLimiter in parent route — shared key space ensures
// the two endpoints count against the same budget per user.
const rotateLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 3 });

/**
 * GET /api/vault/rotate-key/data
 * Bulk-fetch all personal vault data needed by the client before key rotation.
 * Returns all PasswordEntry rows (active + trash) and all PasswordEntryHistory
 * rows for the authenticated user, plus ECDH private key fields.
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

  const [entries, historyEntries, user] = await withUserTenantRls(
    session.user.id,
    async () =>
      Promise.all([
        prisma.passwordEntry.findMany({
          where: { userId: session.user.id },
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
          where: { entry: { userId: session.user.id } },
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
          where: { id: session.user.id },
          select: {
            encryptedEcdhPrivateKey: true,
            ecdhPrivateKeyIv: true,
            ecdhPrivateKeyAuthTag: true,
          },
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

  return NextResponse.json({ entries, historyEntries, ecdhPrivateKey });
}

export const GET = withRequestLog(handleGET);
