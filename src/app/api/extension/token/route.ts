import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { generateShareToken, hashToken } from "@/lib/crypto-server";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { validateExtensionToken } from "@/lib/extension-token";
import { withUserTenantRls } from "@/lib/tenant-context";
import {
  EXTENSION_TOKEN_DEFAULT_SCOPES,
  EXTENSION_TOKEN_TTL_MS,
  EXTENSION_TOKEN_MAX_ACTIVE,
} from "@/lib/constants";

export const runtime = "nodejs";

const tokenLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
});

/**
 * POST /api/extension/token — Issue a new extension token.
 * Requires Auth.js session (user must be logged in on the web app).
 * Returns the plaintext token (only visible once).
 */
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }

  if (!(await tokenLimiter.check(`rl:ext_token:${session.user.id}`))) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 },
    );
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + EXTENSION_TOKEN_TTL_MS);
  const plaintext = generateShareToken();
  const tokenHash = hashToken(plaintext);
  const scopeCsv = EXTENSION_TOKEN_DEFAULT_SCOPES.join(",");
  const actor = await withUserTenantRls(session.user.id, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { tenantId: true },
    }),
  );
  if (!actor) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }

  const created = await withUserTenantRls(session.user.id, async () =>
    prisma.$transaction(async (tx) => {
      // Find active tokens (non-revoked, non-expired)
      const active = await tx.extensionToken.findMany({
        where: { userId: session.user.id, revokedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });

      // Revoke oldest if at max (need room for the new one)
      const over = active.length + 1 - EXTENSION_TOKEN_MAX_ACTIVE;
      if (over > 0) {
        const toRevoke = active.slice(0, over).map((t) => t.id);
        await tx.extensionToken.updateMany({
          where: { id: { in: toRevoke } },
          data: { revokedAt: now },
        });
      }

      return tx.extensionToken.create({
        data: { userId: session.user.id, tenantId: actor.tenantId, tokenHash, scope: scopeCsv, expiresAt },
        select: { id: true, expiresAt: true, scope: true },
      });
    }),
  );

  return NextResponse.json({
    token: plaintext,
    expiresAt: created.expiresAt.toISOString(),
    scope: created.scope.split(","),
  });
}

/**
 * DELETE /api/extension/token — Revoke the token used in Authorization header.
 * The Bearer token identifies which token to revoke.
 */
export async function DELETE(req: NextRequest) {
  const result = await validateExtensionToken(req);

  if (!result.ok) {
    const statusMap: Record<string, number> = {
      EXTENSION_TOKEN_INVALID: 404,
      EXTENSION_TOKEN_REVOKED: 400,
      EXTENSION_TOKEN_EXPIRED: 400,
    };
    return NextResponse.json(
      { error: API_ERROR[result.error] },
      { status: statusMap[result.error] ?? 400 },
    );
  }

  await withUserTenantRls(result.data.userId, async () =>
    prisma.extensionToken.update({
      where: { id: result.data.tokenId },
      data: { revokedAt: new Date() },
    }),
  );

  return NextResponse.json({ ok: true });
}
