/**
 * POST /api/extension/bridge-code — Issue a one-time bridge code.
 *
 * Step 4 of the extension-bridge-code-exchange plan. The web app calls this
 * endpoint after the user signs in and forwards the resulting code via
 * `window.postMessage` to the extension content script. The content script
 * then calls `POST /api/extension/token/exchange` directly to swap the code
 * for a bearer token, never exposing the bearer token to MAIN-world JS.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { generateShareToken, hashToken } from "@/lib/crypto-server";
import { createRateLimiter } from "@/lib/rate-limit";
import { rateLimited, unauthorized } from "@/lib/api-response";
import { assertOrigin } from "@/lib/auth/csrf";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withUserTenantRls } from "@/lib/tenant-context";
import { logAuditAsync, extractRequestMeta, personalAuditBase } from "@/lib/audit";
import { withRequestLog } from "@/lib/with-request-log";
import {
  AUDIT_ACTION,
  EXTENSION_TOKEN_DEFAULT_SCOPES,
  BRIDGE_CODE_TTL_MS,
  BRIDGE_CODE_MAX_ACTIVE,
} from "@/lib/constants";
import { MS_PER_MINUTE } from "@/lib/constants/time";

export const runtime = "nodejs";

const bridgeCodeLimiter = createRateLimiter({
  windowMs: 15 * MS_PER_MINUTE,
  max: 10,
});

async function handlePOST(req: NextRequest) {
  // CSRF defense-in-depth — bridge-code is an Auth.js session POST endpoint
  const originError = assertOrigin(req);
  if (originError) return originError;

  // Auth.js session
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  // Per-user rate limit (matches existing tokenLimiter on POST /api/extension/token)
  const rl = await bridgeCodeLimiter.check(`rl:ext_bridge:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  // Resolve tenant via existing RLS pattern (signature: 2 args)
  const userId = session.user.id;
  const userRecord = await withUserTenantRls(userId, async () =>
    prisma.user.findUnique({
      where: { id: userId },
      select: { tenantId: true },
    }),
  );
  if (!userRecord) {
    return unauthorized();
  }

  // Generate code (256-bit randomBytes via shared helper)
  const code = generateShareToken();
  const codeHash = hashToken(code);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + BRIDGE_CODE_TTL_MS);

  // Extract request metadata once and reuse for both DB record + audit emit
  const meta = extractRequestMeta(req);

  // Atomic: enforce BRIDGE_CODE_MAX_ACTIVE per user (revoke oldest unused)
  // and create the new code in a single withBypassRls / $transaction.
  await withBypassRls(prisma, async () => {
    const active = await prisma.extensionBridgeCode.findMany({
      where: { userId, usedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    const overflow = active.length + 1 - BRIDGE_CODE_MAX_ACTIVE;
    if (overflow > 0) {
      const toRevoke = active.slice(0, overflow).map((r) => r.id);
      await prisma.extensionBridgeCode.updateMany({
        where: { id: { in: toRevoke } },
        data: { usedAt: now },
      });
    }
    await prisma.extensionBridgeCode.create({
      data: {
        codeHash,
        userId,
        tenantId: userRecord.tenantId,
        scope: EXTENSION_TOKEN_DEFAULT_SCOPES.join(","),
        expiresAt,
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    });
  }, BYPASS_PURPOSE.TOKEN_LIFECYCLE);

  // Audit (success path uses logAudit; userId/tenantId both resolved)
  await logAuditAsync({
    ...personalAuditBase(req, userId),
    action: AUDIT_ACTION.EXTENSION_BRIDGE_CODE_ISSUE,
    tenantId: userRecord.tenantId,
  });

  // Response — only the plaintext code and expiry are returned
  return NextResponse.json(
    { code, expiresAt: expiresAt.toISOString() },
    { status: 201 },
  );
}

export const POST = withRequestLog(handlePOST);
