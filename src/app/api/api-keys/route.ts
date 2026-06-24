import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { checkAuth } from "@/lib/auth/session/check-auth";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto/crypto-server";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { apiKeyCreateSchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse } from "@/lib/http/api-response";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { parseBody } from "@/lib/http/parse-body";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { withRequestLog } from "@/lib/http/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import { NO_STORE_HEADERS } from "@/lib/http/cache-headers";
import {
  API_KEY_PREFIX,
  MAX_API_KEYS_PER_USER,
} from "@/lib/constants/auth/api-key";
import { API_KEY_TOKEN_LENGTH, API_KEY_PREFIX_LENGTH } from "@/lib/validations/common";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { MS_PER_HOUR } from "@/lib/constants/time";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";

const apiKeyCreateLimiter = createRateLimiter({
  windowMs: MS_PER_HOUR,
  max: 5,
  failClosedOnRedisError: true,
});

// GET /api/api-keys — List API keys for the current user
async function handleGET(req: NextRequest) {
  const authed = await checkAuth(req);
  if (!authed.ok) return authed.response;
  const { userId } = authed.auth;

  const keys = await withUserTenantRls(userId, async () =>
    prisma.apiKey.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        prefix: true,
        name: true,
        scope: true,
        expiresAt: true,
        createdAt: true,
        revokedAt: true,
        lastUsedAt: true,
      },
    }),
  );

  return NextResponse.json(
    keys.map((k) => ({
      id: k.id,
      prefix: k.prefix,
      name: k.name,
      scopes: k.scope.split(",").filter(Boolean),
      expiresAt: k.expiresAt,
      createdAt: k.createdAt,
      revokedAt: k.revokedAt,
      lastUsedAt: k.lastUsedAt,
    })),
  );
}

// POST /api/api-keys — Create a new API key (session only)
async function handlePOST(req: NextRequest) {
  const authed = await checkAuth(req);
  if (!authed.ok) return authed.response;
  const stepUpError = await requireRecentCurrentAuthMethod(req);
  if (stepUpError) return stepUpError;
  const { userId } = authed.auth;

  const blocked = await checkRateLimitOrFail({
    req,
    limiter: apiKeyCreateLimiter,
    key: `rl:api_key_create:${userId}`,
    scope: "apikey.create",
    userId,
  });
  if (blocked) return blocked;

  const result = await parseBody(req, apiKeyCreateSchema);
  if (!result.ok) return result.response;

  const { name, scope: scopes, expiresAt } = result.data;

  // Check key limit
  const existingCount = await withUserTenantRls(userId, async () =>
    prisma.apiKey.count({
      where: { userId: userId, revokedAt: null },
    }),
  );
  if (existingCount >= MAX_API_KEYS_PER_USER) {
    return errorResponse(API_ERROR.API_KEY_LIMIT_EXCEEDED);
  }

  // Generate token: api_ + 43 chars base62 (256-bit entropy)
  // Use 48 bytes to ensure enough chars remain after stripping _ and -
  const rawBytes = randomBytes(48);
  const base62 = rawBytes
    .toString("base64url")
    .replace(/[_-]/g, "")
    .slice(0, API_KEY_TOKEN_LENGTH);
  if (base62.length < API_KEY_TOKEN_LENGTH) {
    return errorResponse(API_ERROR.SERVICE_UNAVAILABLE);
  }
  const plaintext = `${API_KEY_PREFIX}${base62}`;
  const tokenHash = hashToken(plaintext);
  const prefix = plaintext.slice(0, API_KEY_PREFIX_LENGTH); // "api_XXXX"

  const key = await withUserTenantRls(userId, async (tenantId) =>
    prisma.apiKey.create({
      data: {
        userId: userId,
        tenantId,
        tokenHash,
        prefix,
        name,
        scope: scopes.join(","),
        expiresAt,
      },
    }),
  );

  await logAuditAsync({
    ...personalAuditBase(req, userId),
    action: AUDIT_ACTION.API_KEY_CREATE,
    targetType: AUDIT_TARGET_TYPE.API_KEY,
    targetId: key.id,
    metadata: { name, scopes },
  });

  return NextResponse.json(
    {
      id: key.id,
      token: plaintext, // Only returned once
      prefix,
      name,
      scopes,
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
    },
    { status: 201, headers: { ...NO_STORE_HEADERS } },
  );
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
