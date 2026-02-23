/**
 * POST /api/admin/rotate-master-key
 *
 * Re-wraps all Organization keys from an old master key version to a new one.
 * Authenticated via ADMIN_API_TOKEN bearer token (not session).
 *
 * Body: { targetVersion: number, operatorId: string, revokeShares?: boolean }
 */

import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  getCurrentMasterKeyVersion,
  getMasterKeyByVersion,
} from "@/lib/crypto-server";
import { createRateLimiter } from "@/lib/rate-limit";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { AUDIT_SCOPE, AUDIT_ACTION } from "@/lib/constants/audit";

const HEX64_RE = /^[0-9a-fA-F]{64}$/;

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 1 });

const bodySchema = z.object({
  targetVersion: z.number().int().min(1).max(100),
  operatorId: z.string().min(1),
  revokeShares: z.boolean().default(false),
});

function verifyAdminToken(req: NextRequest): boolean {
  const expectedHex = process.env.ADMIN_API_TOKEN;
  if (!expectedHex || !HEX64_RE.test(expectedHex)) return false;

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;

  const provided = authHeader.slice(7);
  if (!provided || !HEX64_RE.test(provided)) return false;

  // SHA-256 hash comparison with timingSafeEqual to prevent timing attacks
  const expectedHash = createHash("sha256")
    .update(Buffer.from(expectedHex, "hex"))
    .digest();
  const providedHash = createHash("sha256")
    .update(Buffer.from(provided, "hex"))
    .digest();

  return timingSafeEqual(expectedHash, providedHash);
}

export async function POST(req: NextRequest) {
  // Bearer token auth (checked before rate limit to prevent unauthenticated DoS)
  if (!verifyAdminToken(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Rate limit (global fixed key, applied after auth)
  if (!(await rateLimiter.check("rl:admin:rotate"))) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Try again later." },
      { status: 429 }
    );
  }

  // Parse body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation error", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { targetVersion, operatorId, revokeShares } = parsed.data;

  // Verify targetVersion matches current env config (prevent stale requests)
  const currentVersion = getCurrentMasterKeyVersion();
  if (targetVersion !== currentVersion) {
    return NextResponse.json(
      {
        error: `targetVersion (${targetVersion}) does not match ORG_MASTER_KEY_CURRENT_VERSION (${currentVersion})`,
      },
      { status: 400 }
    );
  }

  // Verify the target version key exists
  try {
    getMasterKeyByVersion(targetVersion);
  } catch {
    return NextResponse.json(
      { error: `ORG_MASTER_KEY_V${targetVersion} is not configured` },
      { status: 400 }
    );
  }

  // Verify operatorId is a valid user
  const operator = await prisma.user.findUnique({
    where: { id: operatorId },
    select: { id: true },
  });
  if (!operator) {
    return NextResponse.json(
      { error: "operatorId does not match an existing user" },
      { status: 400 }
    );
  }

  // Revoke old-version shares if requested
  let revokedShares = 0;
  if (revokeShares) {
    const result = await prisma.passwordShare.updateMany({
      where: {
        masterKeyVersion: { lt: targetVersion },
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { revokedAt: new Date() },
    });
    revokedShares = result.count;
  }

  // Audit log (fire-and-forget; logAudit handles errors internally)
  const { ip } = extractRequestMeta(req);
  logAudit({
    scope: AUDIT_SCOPE.ORG,
    action: AUDIT_ACTION.MASTER_KEY_ROTATION,
    userId: operatorId,
    metadata: {
      targetVersion,
      revokedShares,
      ip,
    },
    ip,
  });

  return NextResponse.json({
    targetVersion,
    revokedShares,
  });
}
