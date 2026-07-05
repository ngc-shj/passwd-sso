import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto/crypto-server";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { generateScimToken } from "@/lib/scim/token-utils";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTenantRls, advisoryXactLock } from "@/lib/tenant-rls";
import { z } from "zod";
import { SCIM_TOKEN_DESC_MAX_LENGTH } from "@/lib/validations";
import { withRequestLog } from "@/lib/http/with-request-log";
import { NO_STORE_HEADERS } from "@/lib/http/cache-headers";
import { errorResponse, handleAuthError, unauthorized } from "@/lib/http/api-response";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import {
  SCIM_TOKEN_EXPIRY_MIN_DAYS,
  SCIM_TOKEN_EXPIRY_MAX_DAYS,
  SCIM_TOKEN_EXPIRY_DEFAULT_DAYS,
} from "@/lib/validations/common";
import { MS_PER_DAY, MS_PER_HOUR } from "@/lib/constants/time";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";

const scimTokenCreateLimiter = createRateLimiter({
  windowMs: MS_PER_HOUR,
  max: 5,
  failClosedOnRedisError: true,
});

// Sentinel thrown inside the locked transaction when the re-checked active
// SCIM-token count is at the cap. Mapped to SCIM_TOKEN_LIMIT_EXCEEDED outside
// the tx.
class ScimTokenLimitError extends Error {}

const SCIM_TOKEN_LIMIT_PER_TENANT = 10;

export const runtime = "nodejs";

const createTokenSchema = z.object({
  description: z.string().max(SCIM_TOKEN_DESC_MAX_LENGTH).optional(),
  /** Expiry in days. null = never expires. */
  expiresInDays: z.number().int().min(SCIM_TOKEN_EXPIRY_MIN_DAYS).max(SCIM_TOKEN_EXPIRY_MAX_DAYS).nullable().optional().default(SCIM_TOKEN_EXPIRY_DEFAULT_DAYS),
});

// GET /api/tenant/scim-tokens — List SCIM tokens for the tenant
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
      TENANT_PERMISSION.SCIM_MANAGE,
    );
  } catch (err) {
    return handleAuthError(err);
  }

  const tokens = await withTenantRls(prisma, actor.tenantId, async (tx) =>
    tx.scimToken.findMany({
      where: { tenantId: actor.tenantId },
      select: {
        id: true,
        description: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
        createdBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  );

  return NextResponse.json(tokens);
}

// POST /api/tenant/scim-tokens — Generate a new SCIM token
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  let actor;
  try {
    actor = await requireTenantPermission(
      session.user.id,
      TENANT_PERMISSION.SCIM_MANAGE,
    );
  } catch (err) {
    return handleAuthError(err);
  }

  const stepUpError = await requireRecentCurrentAuthMethod(req);
  if (stepUpError) return stepUpError;

  const blocked = await checkRateLimitOrFail({
    req,
    limiter: scimTokenCreateLimiter,
    key: `rl:scim_token_create:${actor.tenantId}`,
    scope: "tenant.scim_token_create",
    userId: session.user.id,
    tenantId: actor.tenantId,
  });
  if (blocked) return blocked;

  const result = await parseBody(req, createTokenSchema);
  if (!result.ok) return result.response;

  // Token generation + hashing are done outside the locked tx (like api-keys).
  const plaintext = generateScimToken();
  const tokenHash = hashToken(plaintext);

  const expiresAt = result.data.expiresInDays
    ? new Date(Date.now() + result.data.expiresInDays * MS_PER_DAY)
    : null;

  // Serialize the cap check with the create under a per-tenant advisory lock so
  // two concurrent POSTs cannot both read count < LIMIT and both create, blowing
  // past the active-token cap (TOCTOU). Lock, count, and create fold into one
  // tenant tx; over-limit throws a sentinel mapped to a 409 outside the tx.
  let token;
  try {
    token = await withTenantRls(prisma, actor.tenantId, async (tx) => {
      await advisoryXactLock(tx, actor.tenantId);
      const tokenCount = await tx.scimToken.count({
        where: {
          tenantId: actor.tenantId,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      });
      if (tokenCount >= SCIM_TOKEN_LIMIT_PER_TENANT) {
        throw new ScimTokenLimitError();
      }
      return tx.scimToken.create({
        data: {
          tenantId: actor.tenantId,
          tokenHash,
          description: result.data.description ?? null,
          expiresAt,
          createdById: session.user.id,
        },
      });
    });
  } catch (e) {
    if (e instanceof ScimTokenLimitError) {
      return errorResponse(API_ERROR.SCIM_TOKEN_LIMIT_EXCEEDED);
    }
    throw e;
  }

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.SCIM_TOKEN_CREATE,
    targetType: AUDIT_TARGET_TYPE.SCIM_TOKEN,
    targetId: token.id,
    metadata: { description: result.data.description, expiresInDays: result.data.expiresInDays },
  });

  // Return plaintext only once — no-store prevents caching of sensitive token
  return NextResponse.json(
    {
      id: token.id,
      token: plaintext,
      description: token.description,
      expiresAt: token.expiresAt,
      createdAt: token.createdAt,
    },
    { status: 201, headers: { ...NO_STORE_HEADERS } },
  );
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
