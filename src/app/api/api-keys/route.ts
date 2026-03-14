import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { checkAuth } from "@/lib/check-auth";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto-server";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { apiKeyCreateSchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/api-error-codes";
import { parseBody } from "@/lib/parse-body";
import { withRequestLog } from "@/lib/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import {
  API_KEY_PREFIX,
  MAX_API_KEYS_PER_USER,
} from "@/lib/constants/api-key";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";

// GET /api/api-keys — List API keys for the current user
async function handleGET(req: NextRequest) {
  // skipAccessRestriction: deliberate — API key management is session/extension-token only;
  // IP restriction is not enforced here (matches pre-checkAuth behavior).
  const authed = await checkAuth(req, { allowTokens: true, skipAccessRestriction: true });
  if (!authed.ok) return authed.response;
  // API keys cannot manage API keys (only session or extension token)
  if (authed.auth.type === "api_key") {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }
  const userId = authed.auth.userId;

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
  // skipAccessRestriction: deliberate — API key management is session/extension-token only;
  // IP restriction is not enforced here (matches pre-checkAuth behavior).
  const authed = await checkAuth(req, { allowTokens: true, skipAccessRestriction: true });
  if (!authed.ok) return authed.response;
  // API keys cannot create API keys
  if (authed.auth.type === "api_key") {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }
  const userId = authed.auth.userId;

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
    return NextResponse.json(
      { error: API_ERROR.API_KEY_LIMIT_EXCEEDED },
      { status: 400 },
    );
  }

  // Generate token: api_ + 43 chars base62 (256-bit entropy)
  // Use 48 bytes to ensure enough chars remain after stripping _ and -
  const rawBytes = randomBytes(48);
  const base62 = rawBytes
    .toString("base64url")
    .replace(/[_-]/g, "")
    .slice(0, 43);
  if (base62.length < 43) {
    return NextResponse.json(
      { error: API_ERROR.SERVICE_UNAVAILABLE },
      { status: 500 },
    );
  }
  const plaintext = `${API_KEY_PREFIX}${base62}`;
  const tokenHash = hashToken(plaintext);
  const prefix = plaintext.slice(0, 8); // "api_XXXX"

  const actor = await withUserTenantRls(userId, async () =>
    prisma.user.findUnique({
      where: { id: userId },
      select: { tenantId: true },
    }),
  );
  if (!actor) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const key = await withUserTenantRls(userId, async () =>
    prisma.apiKey.create({
      data: {
        userId: userId,
        tenantId: actor.tenantId,
        tokenHash,
        prefix,
        name,
        scope: scopes.join(","),
        expiresAt,
      },
    }),
  );

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.API_KEY_CREATE,
    userId: userId,
    targetType: AUDIT_TARGET_TYPE.API_KEY,
    targetId: key.id,
    metadata: { name, scopes },
    ...extractRequestMeta(req),
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
