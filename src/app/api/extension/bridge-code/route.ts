/**
 * POST /api/extension/bridge-code — Issue a one-time bridge code.
 *
 * The web app's UI is rendered same-origin; the chrome extension SW initiates
 * this request itself with credentials and a DPoP proof. The route handler
 * enforces its own Origin allowlist (the proxy classifies bridge-code as
 * API_EXTENSION_BRIDGE_CODE so the baseline CSRF gate does NOT fire — see
 * `src/lib/proxy/api-route.ts:55` and plan C2/C4).
 *
 * Step order (cheap → expensive, fail-fast). Per-step justifications:
 *
 *   1. IP-keyed rate limit (60/min/IP, fail-closed on Redis error) BEFORE
 *      Origin — anonymous-DoS gate at the cheapest layer.
 *   2. Origin allowlist (exact match on EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS).
 *   3. Body schema `z.object({}).strict()` — rejects unknown keys including
 *      any client-supplied `cnfJkt` (closes the body-spoofing gap).
 *   4. Auth.js session check — moved BEFORE DPoP verify so unauthenticated
 *      callers don't burn ES256 + JTI cache work.
 *   4a. Tenant IP access restriction — proxy short-circuit bypassed the
 *       normal IP gate, restore it here.
 *   5. Step-up auth (requireRecentCurrentAuthMethod).
 *   6. Per-user rate limit.
 *   7. DPoP proof verify — `cnfJkt` comes from `result.jkt` (the verifier's
 *      thumbprint of the proof's own JWK), NEVER from request body.
 *   8. DB write (BRIDGE_CODE_MAX_ACTIVE enforcement + create row).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { generateShareToken, hashToken } from "@/lib/crypto/crypto-server";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { errorResponse, forbidden, unauthorized } from "@/lib/http/api-response";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { checkIpRateLimit } from "@/lib/security/ip-rate-limit";
import { extractClientIp } from "@/lib/auth/policy/ip-access";
import { checkAccessRestrictionWithAudit } from "@/lib/auth/policy/access-restriction";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withUserTenantRls } from "@/lib/tenant-context";
import { logAuditAsync, extractRequestMeta, personalAuditBase } from "@/lib/audit/audit";
import { emitBridgeCodeIssueFailure } from "@/lib/audit/bridge-code-failure";
import { parseBody } from "@/lib/http/parse-body";
import { withRequestLog } from "@/lib/http/with-request-log";
import { getLogger } from "@/lib/logger";
import {
  AUDIT_ACTION,
  EXTENSION_TOKEN_DEFAULT_SCOPES,
  BRIDGE_CODE_TTL_MS,
  BRIDGE_CODE_MAX_ACTIVE,
  API_PATH,
} from "@/lib/constants";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { isBridgeCodeOriginAllowed } from "@/lib/http/cors";
import { verifyDpopProof } from "@/lib/auth/dpop/verify";
import { getJtiCache } from "@/lib/auth/dpop/jti-cache";
import { canonicalHtu } from "@/lib/auth/dpop/htu-canonical";

// Strict empty-object schema — cnfJkt is intentionally NOT declared. Any
// client-supplied `cnfJkt` (or any other key) is rejected as
// VALIDATION_ERROR. The trust path is now: DPoP signer key → verifier-
// derived thumbprint → DB row. Body cannot influence the bound key.
const BridgeCodeIssueSchema = z.object({}).strict();

export const runtime = "nodejs";

// IP-keyed gate. 60/min matches the anon-DoS budget for similar pre-auth
// endpoints. Fail-closed on Redis error so a Redis outage cannot be used
// to drown the route in unbounded requests.
const ipLimiter = createRateLimiter({
  windowMs: MS_PER_MINUTE,
  max: 60,
  failClosedOnRedisError: true,
});

// Per-user budget once authenticated. Aligns with the legacy
// bridgeCodeLimiter shape (10/15min) — preserved unchanged from PR #491.
const bridgeCodeLimiter = createRateLimiter({
  windowMs: 15 * MS_PER_MINUTE,
  max: 10,
  failClosedOnRedisError: true,
});

async function handlePOST(req: NextRequest) {
  // 1) IP-keyed rate limit — cheapest gate, runs before any cookie/header parse.
  const clientIp = extractClientIp(req);
  const ipRl = await checkIpRateLimit({
    ip: clientIp,
    pathname: req.nextUrl.pathname,
    scope: "ext_bridge_ip",
    limiter: ipLimiter,
  });
  const ipBlocked = await checkRateLimitOrFail({
    req,
    result: ipRl,
    scope: "extension.bridge_code_ip",
    userId: null,
  });
  if (ipBlocked) {
    await emitBridgeCodeIssueFailure({
      req,
      userId: null,
      tenantId: null,
      reason: ipRl.redisErrored ? "ip_rate_limit_redis_fail" : "ip_rate_limit",
    });
    return ipBlocked;
  }

  // 2) Origin allowlist. The proxy intentionally bypasses CSRF for this
  //    route — we are the sole layer enforcing Origin against
  //    EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS. Fail-closed when the env var
  //    is unset (no entries in the Set → every origin rejected).
  const origin = req.headers.get("origin");
  if (!isBridgeCodeOriginAllowed(origin)) {
    await emitBridgeCodeIssueFailure({
      req,
      userId: null,
      tenantId: null,
      reason: "origin_disallowed",
    });
    return forbidden();
  }

  // 3) Body schema — strict empty object. Rejects ANY client-supplied
  //    field (most importantly `cnfJkt`), closing the body-spoofing gap.
  const bodyResult = await parseBody(req, BridgeCodeIssueSchema);
  if (!bodyResult.ok) {
    await emitBridgeCodeIssueFailure({
      req,
      userId: null,
      tenantId: null,
      reason: "body_schema_invalid",
    });
    return bodyResult.response;
  }

  // 4) Auth.js session check.
  const session = await auth();
  if (!session?.user?.id) {
    await emitBridgeCodeIssueFailure({
      req,
      userId: null,
      tenantId: null,
      reason: "unauthenticated",
    });
    return unauthorized();
  }
  const userId = session.user.id;

  // 4a) Tenant IP access restriction. The proxy early-return for
  //     API_EXTENSION_BRIDGE_CODE skipped the normal IP gate — restore it
  //     here, scoped to the authenticated user's tenant.
  const userRecord = await withUserTenantRls(userId, async () =>
    prisma.user.findUnique({
      where: { id: userId },
      select: { tenantId: true },
    }),
  );
  if (!userRecord) {
    await emitBridgeCodeIssueFailure({
      req,
      userId,
      tenantId: null,
      reason: "user_not_found",
    });
    return unauthorized();
  }
  if (userRecord.tenantId) {
    const access = await checkAccessRestrictionWithAudit(
      userRecord.tenantId,
      clientIp,
      userId,
      req,
    );
    if (!access.allowed) {
      await emitBridgeCodeIssueFailure({
        req,
        userId,
        tenantId: userRecord.tenantId,
        reason: "tenant_access_restricted",
      });
      return errorResponse(API_ERROR.ACCESS_DENIED);
    }
  }

  // 5) Step-up gate.
  const stepUpError = await requireRecentCurrentAuthMethod(req);
  if (stepUpError) {
    await emitBridgeCodeIssueFailure({
      req,
      userId,
      tenantId: userRecord.tenantId,
      reason: "step_up_required",
    });
    return stepUpError;
  }

  // 6) Per-user rate limit. Pre-computed-result form so the route can
  //    observe `rl.redisErrored` and pick the right failure reason.
  const rl = await bridgeCodeLimiter.check(`rl:ext_bridge:${userId}`);
  const blocked = await checkRateLimitOrFail({
    req,
    result: rl,
    scope: "extension.bridge_code",
    userId,
  });
  if (blocked) {
    await emitBridgeCodeIssueFailure({
      req,
      userId,
      tenantId: userRecord.tenantId,
      reason: rl.redisErrored ? "rate_limit_redis_fail" : "rate_limit",
    });
    return blocked;
  }

  // 7) DPoP proof verify. `cnfJkt` is the verifier-returned thumbprint of
  //    the proof's own JWK — NOT a body field. No expectedAth (no access
  //    token exists at this stage), no expectedCnfJkt (this IS the
  //    discovery step that binds the key for the first time).
  const dpopHeader = req.headers.get("dpop");
  const dpopResult = await verifyDpopProof(dpopHeader, {
    expectedHtm: "POST",
    expectedHtu: canonicalHtu({ route: API_PATH.EXTENSION_BRIDGE_CODE }),
    expectedNonce: null,
    jtiCache: getJtiCache(),
  });
  if (!dpopResult.ok) {
    await emitBridgeCodeIssueFailure({
      req,
      userId,
      tenantId: userRecord.tenantId,
      reason: "dpop_invalid",
      dpopError: dpopResult.error,
    });
    return unauthorized();
  }
  const cnfJkt = dpopResult.jkt;

  // 8) DB write — atomic BRIDGE_CODE_MAX_ACTIVE enforcement + create row.
  const code = generateShareToken();
  const codeHash = hashToken(code);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + BRIDGE_CODE_TTL_MS);
  const meta = extractRequestMeta(req);

  try {
    await withBypassRls(prisma, async (tx) => {
      const active = await tx.extensionBridgeCode.findMany({
        where: { userId, usedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      const overflow = active.length + 1 - BRIDGE_CODE_MAX_ACTIVE;
      if (overflow > 0) {
        const toRevoke = active.slice(0, overflow).map((r) => r.id);
        await tx.extensionBridgeCode.updateMany({
          where: { id: { in: toRevoke } },
          data: { usedAt: now },
        });
      }
      await tx.extensionBridgeCode.create({
        data: {
          codeHash,
          userId,
          tenantId: userRecord.tenantId,
          scope: EXTENSION_TOKEN_DEFAULT_SCOPES.join(","),
          expiresAt,
          cnfJkt,
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
      });
    }, BYPASS_PURPOSE.TOKEN_LIFECYCLE);
  } catch (err) {
    await emitBridgeCodeIssueFailure({
      req,
      userId,
      tenantId: userRecord.tenantId,
      reason: "db_error",
    });
    getLogger().error(
      {
        event: "extension_bridge_code_issue_failure",
        reason: "db_error",
        userId,
        err,
      },
      "extension bridge-code issuance failed: DB write threw",
    );
    return errorResponse(API_ERROR.INTERNAL_ERROR);
  }

  await logAuditAsync({
    ...personalAuditBase(req, userId),
    action: AUDIT_ACTION.EXTENSION_BRIDGE_CODE_ISSUE,
    tenantId: userRecord.tenantId,
  });

  return NextResponse.json(
    { code, expiresAt: expiresAt.toISOString() },
    { status: 201 },
  );
}

export const POST = withRequestLog(handlePOST);
