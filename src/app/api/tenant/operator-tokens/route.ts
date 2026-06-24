import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto/crypto-server";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/http/with-request-log";
import { NO_STORE_HEADERS } from "@/lib/http/cache-headers";
import {
  errorResponse,
  handleAuthError,
  rateLimited,
  unauthorized,
} from "@/lib/http/api-response";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { MS_PER_DAY } from "@/lib/constants/time";
import { RATE_WINDOW_MS } from "@/lib/validations/common.server";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import {
  OPERATOR_TOKEN_PREFIX,
  OPERATOR_TOKEN_DEFAULT_EXPIRES_DAYS,
  OPERATOR_TOKEN_MAX_EXPIRES_DAYS,
  OPERATOR_TOKEN_MIN_EXPIRES_DAYS,
  OPERATOR_TOKEN_NAME_MAX_LENGTH,
  OPERATOR_TOKEN_SCOPE,
} from "@/lib/constants/auth/operator-token";

export const runtime = "nodejs";

const TOKEN_LIMIT_PER_TENANT = 50;

const createTokenLimiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: 5 });
const listTokenLimiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: 30 });

const createTokenSchema = z
  .object({
    name: z.string().min(1).max(OPERATOR_TOKEN_NAME_MAX_LENGTH),
    expiresInDays: z
      .number()
      .int()
      .min(OPERATOR_TOKEN_MIN_EXPIRES_DAYS)
      .max(OPERATOR_TOKEN_MAX_EXPIRES_DAYS)
      .default(OPERATOR_TOKEN_DEFAULT_EXPIRES_DAYS),
    scope: z
      .enum([OPERATOR_TOKEN_SCOPE.MAINTENANCE])
      .default(OPERATOR_TOKEN_SCOPE.MAINTENANCE),
  })
  .strict();

/**
 * Generate an operator-token plaintext.
 * Format: `op_` + 32-byte (256-bit) random base64url = 46 chars total.
 */
function generateOperatorToken(): string {
  return OPERATOR_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

// GET /api/tenant/operator-tokens — list tokens for the tenant
async function handleGET(req: NextRequest) {
  void req;

  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  let actor;
  try {
    actor = await requireTenantPermission(
      session.user.id,
      TENANT_PERMISSION.OPERATOR_TOKEN_MANAGE,
    );
  } catch (err) {
    return handleAuthError(err);
  }

  const rl = await listTokenLimiter.check(`rl:op_token_list:${session.user.id}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  const tokens = await withTenantRls(prisma, actor.tenantId, async (tx) =>
    tx.operatorToken.findMany({
      where: { tenantId: actor.tenantId },
      select: {
        id: true,
        prefix: true,
        name: true,
        scope: true,
        expiresAt: true,
        revokedAt: true,
        lastUsedAt: true,
        createdAt: true,
        subjectUserId: true,
        createdByUserId: true,
        subjectUser: { select: { id: true, name: true, email: true } },
        createdBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  );

  return NextResponse.json({ tokens });
}

// POST /api/tenant/operator-tokens — mint a new token (one-time plaintext)
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  let actor;
  try {
    actor = await requireTenantPermission(
      session.user.id,
      TENANT_PERMISSION.OPERATOR_TOKEN_MANAGE,
    );
  } catch (err) {
    return handleAuthError(err);
  }

  const stepUpError = await requireRecentCurrentAuthMethod(req, {
    errorCode: API_ERROR.OPERATOR_TOKEN_STALE_SESSION,
  });
  if (stepUpError) return stepUpError;

  const rl = await createTokenLimiter.check(
    `rl:op_token_create:${actor.tenantId}`,
  );
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  const result = await parseBody(req, createTokenSchema);
  if (!result.ok) return result.response;

  // Cap active tokens per tenant
  const tokenCount = await withTenantRls(prisma, actor.tenantId, async (tx) =>
    tx.operatorToken.count({
      where: {
        tenantId: actor.tenantId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    }),
  );
  if (tokenCount >= TOKEN_LIMIT_PER_TENANT) {
    return errorResponse(API_ERROR.OPERATOR_TOKEN_LIMIT_EXCEEDED);
  }

  const plaintext = generateOperatorToken();
  const tokenHash = hashToken(plaintext);
  const prefix = plaintext.slice(0, 8);
  const expiresAt = new Date(
    Date.now() + result.data.expiresInDays * MS_PER_DAY,
  );

  // Server hard-codes subjectUserId = createdByUserId = session.userId.
  // The Zod schema is `.strict()` so a body-injected subjectUserId is rejected
  // before reaching this point.
  const token = await withTenantRls(prisma, actor.tenantId, async (tx) =>
    tx.operatorToken.create({
      data: {
        tenantId: actor.tenantId,
        tokenHash,
        prefix,
        name: result.data.name,
        subjectUserId: session.user.id,
        createdByUserId: session.user.id,
        scope: result.data.scope,
        expiresAt,
      },
      select: {
        id: true,
        prefix: true,
        name: true,
        scope: true,
        expiresAt: true,
        createdAt: true,
      },
    }),
  );

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.OPERATOR_TOKEN_CREATE,
    targetType: AUDIT_TARGET_TYPE.OPERATOR_TOKEN,
    targetId: token.id,
    metadata: {
      tokenId: token.id,
      tokenSubjectUserId: session.user.id,
      scope: token.scope,
      expiresAt: token.expiresAt.toISOString(),
    },
  });

  // Plaintext shown ONCE; Cache-Control: no-store to prevent caching
  return NextResponse.json(
    {
      id: token.id,
      prefix: token.prefix,
      plaintext,
      name: token.name,
      scope: token.scope,
      expiresAt: token.expiresAt,
      createdAt: token.createdAt,
    },
    { status: 201, headers: { ...NO_STORE_HEADERS } },
  );
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
