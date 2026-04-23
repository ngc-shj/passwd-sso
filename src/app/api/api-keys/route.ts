import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { checkAuth } from "@/lib/auth/check-auth";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto-server";
import { logAuditAsync, personalAuditBase } from "@/lib/audit";
import { apiKeyCreateSchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, unauthorized, rateLimited } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";
import { createRateLimiter } from "@/lib/rate-limit";
import { withRequestLog } from "@/lib/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import {
  API_KEY_PREFIX,
  MAX_API_KEYS_PER_USER,
} from "@/lib/constants/api-key";
import { API_KEY_TOKEN_LENGTH, API_KEY_PREFIX_LENGTH } from "@/lib/validations/common";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { MS_PER_HOUR } from "@/lib/constants/time";

const apiKeyCreateLimiter = createRateLimiter({ windowMs: MS_PER_HOUR, max: 5 });

// GET /api/api-keys — List API keys for the current user
async function handleGET(req: NextRequest) {
  // Tenant IP restriction applies to all auth types (session + extension token)
  // to prevent long-lived API-key issuance from outside the tenant network boundary.
  const authed = await checkAuth(req, { allowTokens: true });
  if (!authed.ok) return authed.response;
  // Only session and extension token can manage API keys
  if (authed.auth.type === "api_key" || authed.auth.type === "mcp_token") {
    return unauthorized();
  }
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

// POST /api/api-keys — Create a new API key (session or extension token, NOT API key)
async function handlePOST(req: NextRequest) {
  const authed = await checkAuth(req, { allowTokens: true });
  if (!authed.ok) return authed.response;
  // Only session and extension token can create API keys
  if (authed.auth.type === "api_key" || authed.auth.type === "mcp_token") {
    return unauthorized();
  }
  const { userId } = authed.auth;

  const rl = await apiKeyCreateLimiter.check(`rl:api_key_create:${userId}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

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
    return errorResponse(API_ERROR.API_KEY_LIMIT_EXCEEDED, 400);
  }

  // Generate token: api_ + 43 chars base62 (256-bit entropy)
  // Use 48 bytes to ensure enough chars remain after stripping _ and -
  const rawBytes = randomBytes(48);
  const base62 = rawBytes
    .toString("base64url")
    .replace(/[_-]/g, "")
    .slice(0, API_KEY_TOKEN_LENGTH);
  if (base62.length < API_KEY_TOKEN_LENGTH) {
    return errorResponse(API_ERROR.SERVICE_UNAVAILABLE, 500);
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
    { status: 201 },
  );
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
