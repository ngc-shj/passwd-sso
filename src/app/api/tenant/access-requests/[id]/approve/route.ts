import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto/crypto-server";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTenantRls, withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { transition, AR_STATUS, AR_ACTOR } from "@/lib/access-request/access-request-state";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, errorResponseWithMessage, handleAuthError, notFound, unauthorized } from "@/lib/http/api-response";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { SA_TOKEN_PREFIX, MAX_SA_TOKENS_PER_ACCOUNT } from "@/lib/constants/auth/service-account";
import { parseSaTokenScopes } from "@/lib/auth/tokens/service-account-token";
import { randomBytes } from "node:crypto";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { MS_PER_MINUTE, MS_PER_SECOND, SEC_PER_HOUR } from "@/lib/constants/time";
import { JIT_TOKEN_TTL_MAX } from "@/lib/validations/common";

type Params = { params: Promise<{ id: string }> };

const approveLimiter = createRateLimiter({
  windowMs: MS_PER_MINUTE,
  max: 10,
  failClosedOnRedisError: true,
});

export const runtime = "nodejs";


// POST /api/tenant/access-requests/[id]/approve — Approve an access request and issue JIT token
async function handlePOST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  let actor;
  try {
    actor = await requireTenantPermission(
      session.user.id,
      TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE,
    );
  } catch (err) {
    return handleAuthError(err);
  }

  const stepUpError = await requireRecentCurrentAuthMethod(req);
  if (stepUpError) return stepUpError;

  const blocked = await checkRateLimitOrFail({
    req,
    limiter: approveLimiter,
    key: `rl:access_request_approve:${actor.tenantId}`,
    scope: "access_request.approve",
    userId: session.user.id,
    tenantId: actor.tenantId,
  });
  if (blocked) return blocked;

  const { id: requestId } = await params;

  // Fetch the access request to get serviceAccountId and requestedScope
  const request = await withTenantRls(prisma, actor.tenantId, async (tx) =>
    tx.accessRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        tenantId: true,
        serviceAccountId: true,
        requestedScope: true,
        status: true,
        expiresAt: true,
        requesterUserId: true,
        requesterServiceAccountId: true,
        serviceAccount: { select: { isActive: true, createdById: true } },
      },
    }),
  );

  if (!request || request.tenantId !== actor.tenantId) {
    return notFound();
  }

  // C8 (OWASP A01-1): reject self-approval. Critical for the dual-control
  // property of JIT access — a compromised admin session must not be able
  // to issue itself or its own SA permanent escalation tokens.
  //   - Admin-created (requesterUserId set): reject if approver == requester.
  //   - SA self-service (requesterServiceAccountId set): reject if approver
  //     == the SA's creator (one identity acting through two surfaces).
  //   - Legacy rows lacking both fields: 400 invalid_request rather than
  //     fail-open. Pre-1.0 migration set such rows to EXPIRED so this
  //     only fires on data inserted before the column landed.
  if (request.requesterUserId === null && request.requesterServiceAccountId === null) {
    return errorResponse(API_ERROR.INVALID_REQUEST);
  }
  if (request.requesterUserId === session.user.id) {
    return errorResponse(API_ERROR.FORBIDDEN_SELF_APPROVAL);
  }
  if (
    request.requesterServiceAccountId !== null &&
    request.serviceAccount.createdById === session.user.id
  ) {
    return errorResponse(API_ERROR.FORBIDDEN_SELF_APPROVAL);
  }

  // Reject approval of expired requests — the state-machine transition() only
  // gates on status (PENDING), not on the request's own deadline. Without this
  // check, an admin could revive a stale request and issue a fresh JIT token
  // long after the requester's intent has expired.
  if (request.expiresAt.getTime() <= Date.now()) {
    return errorResponse(API_ERROR.SA_ACCESS_REQUEST_EXPIRED);
  }

  if (!request.serviceAccount.isActive) {
    return errorResponseWithMessage(API_ERROR.SA_INACTIVE, "Service account is inactive");
  }

  // Read tenant policy for JIT TTL bounds
  const tenant = await withBypassRls(prisma, async (tx) =>
    tx.tenant.findUnique({
      where: { id: actor.tenantId },
      select: { jitTokenDefaultTtlSec: true, jitTokenMaxTtlSec: true },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  const defaultTtlSec = tenant?.jitTokenDefaultTtlSec ?? SEC_PER_HOUR;
  const maxTtlSec = Math.min(tenant?.jitTokenMaxTtlSec ?? JIT_TOKEN_TTL_MAX, JIT_TOKEN_TTL_MAX);
  const ttlSec = Math.min(defaultTtlSec, maxTtlSec);

  let result: { plaintext: string; expiresAt: Date; tokenId: string };
  try {
    result = await withTenantRls(prisma, actor.tenantId, async (tx) => {
      // Serialize concurrent token issuance for the same SA (this approve path
      // AND the direct token-create route share this lock key) so the
      // count→create limit check cannot be raced past MAX_SA_TOKENS_PER_ACCOUNT
      // under READ COMMITTED.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${request.serviceAccountId}::text))`;

      // Enforce token limit per SA. "Active" = not revoked AND not expired,
      // matching extension/operator/SCIM token limit checks — expired-but-not-
      // revoked tokens are unusable and must not consume a slot.
      const activeTokenCount = await tx.serviceAccountToken.count({
        where: {
          serviceAccountId: request.serviceAccountId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      if (activeTokenCount >= MAX_SA_TOKENS_PER_ACCOUNT) {
        throw new Error("Token limit exceeded");
      }

      // Optimistic lock: only update if still PENDING, belongs to this tenant,
      // AND has not expired. The pre-transaction expiry check above is the
      // common-case fast path; gating expiresAt atomically here closes the
      // TOCTOU window where the request crosses its deadline between that read
      // and this write — JIT expiry is a security boundary, so a token must not
      // be issued for a request that expired mid-flight (race lands as CONFLICT).
      // C6: throw on { ok: false } to abort the transaction — SA-token creation
      // below must not commit if the status transition did not fire.
      const transitionResult = await transition({
        db: tx,
        where: { id: requestId, tenantId: actor.tenantId, expiresAt: { gt: new Date() } },
        to: AR_STATUS.APPROVED,
        actor: AR_ACTOR.ADMIN,
        extraData: { approvedById: session.user.id, approvedAt: new Date() },
      });

      if (!transitionResult.ok) {
        throw new Error("Already processed or wrong tenant");
      }

      // Re-validate scope against SA allowlist at approval time
      const validatedScopes = parseSaTokenScopes(request.requestedScope);
      if (validatedScopes.length === 0) {
        throw new Error("No valid scopes after re-validation");
      }
      const validatedScope = validatedScopes.join(",");

      // Issue a short-lived SA token scoped to validated scopes only
      const plaintext = SA_TOKEN_PREFIX + randomBytes(32).toString("hex");
      const tokenHash = hashToken(plaintext);
      const expiresAt = new Date(Date.now() + ttlSec * MS_PER_SECOND);

      const token = await tx.serviceAccountToken.create({
        data: {
          serviceAccountId: request.serviceAccountId,
          tenantId: actor.tenantId,
          tokenHash,
          prefix: plaintext.slice(0, 7),
          name: `JIT-${requestId.slice(0, 8)}`,
          scope: validatedScope,
          expiresAt,
        },
      });

      await tx.accessRequest.update({
        where: { id: requestId, tenantId: actor.tenantId },
        data: { grantedTokenId: token.id, grantedTokenTtlSec: ttlSec },
      });

      return { plaintext, expiresAt, tokenId: token.id };
    });
  } catch (err) {
    if (err instanceof Error && err.message === "Already processed or wrong tenant") {
      return errorResponse(API_ERROR.CONFLICT);
    }
    if (err instanceof Error && err.message === "Token limit exceeded") {
      return errorResponse(API_ERROR.SA_TOKEN_LIMIT_EXCEEDED);
    }
    if (err instanceof Error && err.message === "No valid scopes after re-validation") {
      return errorResponseWithMessage(API_ERROR.SA_INVALID_SCOPE, "No valid scopes remain after re-validation");
    }
    throw err;
  }

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.ACCESS_REQUEST_APPROVE,
    targetType: AUDIT_TARGET_TYPE.ACCESS_REQUEST,
    targetId: requestId,
    metadata: {
      serviceAccountId: request.serviceAccountId,
      tokenId: result.tokenId,
      ttlSec,
    },
  });

  // Return plaintext token only once — no-store prevents caching of sensitive token
  return NextResponse.json(
    {
      token: result.plaintext,
      expiresAt: result.expiresAt,
      ttlSec,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export const POST = withRequestLog(handlePOST);
