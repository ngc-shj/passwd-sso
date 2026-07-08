/**
 * POST /api/extension/token/exchange — Exchange a one-time bridge code for a token.
 *
 * Called from the extension SW after a successful bridge-code issuance. The
 * endpoint runs SELECT-then-CAS (not CAS-then-SELECT):
 *
 *   1. Validate the request body (64-char hex code + strict schema).
 *   2. Rate-limit per client IP (no session is available at this point).
 *   3. `findUnique` the bridge code by codeHash — read-only, no mutation.
 *   4. `verifyDpopProof` with `expectedCnfJkt: consumed.cnfJkt` — proves the
 *      caller controls the same key the bridge code was bound to. If the
 *      proof fails, NO MUTATION happens (this fixes the DoS-via-consumption
 *      window where the prior CAS-first design consumed codes on invalid
 *      DPoP, denying the legitimate caller their own code).
 *   5. `updateMany` CAS with predicate `{ codeHash, usedAt: null,
 *      cnfJkt: consumed.cnfJkt, expiresAt: { gt: now } }`. The cnfJkt
 *      predicate is a defense-in-depth TOCTOU guard — the verifier already
 *      established `dpopResult.jkt === consumed.cnfJkt`, but re-asserting
 *      it at the CAS layer prevents any pathological scenario where the
 *      row's cnfJkt could change between SELECT and CAS.
 *   6. If `count === 0`: race-lost (another caller consumed in between).
 *      Same 401 + audit reason `unknown_or_consumed` as code-unknown.
 *   7. Issue an extension token via the shared `issueExtensionToken()`
 *      helper, passing `consumed.cnfJkt` so the token row's cnfJkt
 *      matches.
 *
 * No Auth.js session and no Origin check by design — the SW initiates this
 * exchange directly with `credentials:"omit"`, so neither cookies nor a
 * meaningful Origin header reach this route. The cross-origin authentication
 * for this endpoint is the bridge code itself (256-bit single-use, short TTL)
 * plus the DPoP proof of key custody. The companion bridge-code endpoint
 * (`/api/extension/bridge-code`, see C2/C4) does enforce Origin against the
 * EXTENSION_BRIDGE_CODE_ALLOWED_ORIGINS allowlist — that's where the
 * extension's identity is gated.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto/crypto-server";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import {
  errorResponse,
  unauthorized,
} from "@/lib/http/api-response";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { issueExtensionToken } from "@/lib/auth/tokens/extension-token";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { extractClientIp } from "@/lib/auth/policy/ip-access";
import { enforceAccessRestriction } from "@/lib/auth/policy/access-restriction";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { checkIpRateLimit } from "@/lib/security/ip-rate-limit";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { getLogger } from "@/lib/logger";
import { parseBody } from "@/lib/http/parse-body";
import { withRequestLog } from "@/lib/http/with-request-log";
import { NO_STORE_HEADERS } from "@/lib/http/cache-headers";
import { AUDIT_ACTION, BRIDGE_CODE_LENGTH } from "@/lib/constants";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { verifyDpopProof } from "@/lib/auth/dpop/verify";
import { getJtiCache } from "@/lib/auth/dpop/jti-cache";
import { canonicalHtu } from "@/lib/auth/dpop/htu-canonical";

export const runtime = "nodejs";

const exchangeLimiter = createRateLimiter({
  windowMs: 15 * MS_PER_MINUTE,
  max: 10,
  failClosedOnRedisError: true,
});

// `.strict()` rejects unknown keys. Future field additions require a plan
// amendment — the schema is the authoritative wire contract for this route.
const ExchangeRequestSchema = z
  .object({
    code: z.string().length(BRIDGE_CODE_LENGTH).regex(/^[a-f0-9]+$/),
  })
  .strict();

async function handlePOST(req: NextRequest) {
  // 1. Parse + validate body.
  const bodyResult = await parseBody(req, ExchangeRequestSchema);
  if (!bodyResult.ok) {
    getLogger().warn(
      {
        event: "extension_token_exchange_failure",
        reason: "invalid_request",
        ip: extractClientIp(req),
        userAgent: req.headers.get("user-agent"),
      },
      "extension token exchange failed: malformed body",
    );
    return bodyResult.response;
  }

  const { code } = bodyResult.data;

  // 2. IP rate limit BEFORE DB lookup.
  const ip = extractClientIp(req);
  const rl = await checkIpRateLimit({
    ip,
    pathname: req.nextUrl.pathname,
    scope: "ext_exchange",
    limiter: exchangeLimiter,
  });
  const blocked = await checkRateLimitOrFail({
    req,
    result: rl,
    scope: "extension.token_exchange",
    userId: null,
  });
  if (blocked) return blocked;

  // 3. SELECT — read-only lookup; no mutation. Either resolves a row or
  //    fast-fails as unknown.
  const codeHash = hashToken(code);
  const now = new Date();

  const consumed = await withBypassRls(
    prisma,
    async (tx) =>
      tx.extensionBridgeCode.findUnique({
        where: { codeHash },
        select: { userId: true, tenantId: true, scope: true, cnfJkt: true },
      }),
    BYPASS_PURPOSE.TOKEN_LIFECYCLE,
  );

  if (!consumed) {
    // Code unknown — same 401 envelope used for consumed/expired/race-lost
    // so a probing attacker cannot tell these states apart from response shape.
    getLogger().warn(
      {
        event: "extension_token_exchange_failure",
        reason: "unknown_or_consumed",
        ip,
        userAgent: req.headers.get("user-agent"),
      },
      "extension token exchange failed: code unknown",
    );
    return unauthorized();
  }

  // 3b. Tenant network access restriction — a stolen bridge code must not be
  //     exchanged for an extension token from an off-network IP. Enforced on the
  //     resolved tenantId BEFORE the DPoP/CAS-consume so an off-network attempt
  //     neither consumes the code nor mints a token (matching the MCP token
  //     endpoint and the D5a control; companion refresh route already enforces).
  const denied = await enforceAccessRestriction(
    req,
    consumed.userId ?? SYSTEM_ACTOR_ID,
    consumed.tenantId,
    ACTOR_TYPE.HUMAN,
  );
  if (denied) return denied;

  // 4. DPoP verification — REQUIRED before any mutation. Failure here MUST
  //    NOT consume the bridge code (the prior CAS-first design did, opening
  //    a DoS-via-consumption window).
  const dpopHeader = req.headers.get("dpop");
  const dpopResult = await verifyDpopProof(dpopHeader, {
    expectedHtm: "POST",
    expectedHtu: canonicalHtu({ route: "/api/extension/token/exchange" }),
    expectedCnfJkt: consumed.cnfJkt,
    expectedNonce: null,
    jtiCache: getJtiCache(),
  });

  if (!dpopResult.ok) {
    getLogger().warn(
      {
        event: "extension_token_exchange_failure",
        reason: "dpop_invalid",
        dpopError: dpopResult.error,
        ip,
        userAgent: req.headers.get("user-agent"),
      },
      "extension token exchange failed: DPoP proof invalid",
    );
    await logAuditAsync({
      ...personalAuditBase(req, consumed.userId),
      tenantId: consumed.tenantId,
      action: AUDIT_ACTION.EXTENSION_TOKEN_EXCHANGE_FAILURE,
      metadata: { reason: "dpop_invalid", dpopError: dpopResult.error },
    });
    return unauthorized();
  }

  // 5. CAS consume — atomic UPDATE conditioned on usedAt:null + cnfJkt match
  //    + not-yet-expired. The cnfJkt predicate is defense-in-depth (verifier
  //    already enforced it on the read above). updateMany returns
  //    `{ count }` rather than throwing on miss, which is what we need to
  //    detect the race-lost case.
  const consumeResult = await withBypassRls(
    prisma,
    async (tx) =>
      tx.extensionBridgeCode.updateMany({
        where: {
          codeHash,
          usedAt: null,
          cnfJkt: consumed.cnfJkt,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      }),
    BYPASS_PURPOSE.TOKEN_LIFECYCLE,
  );

  if (consumeResult.count === 0) {
    // Race lost (another caller consumed between SELECT and CAS) OR the row
    // expired during DPoP verification. Same response envelope as code-unknown.
    getLogger().warn(
      {
        event: "extension_token_exchange_failure",
        reason: "unknown_or_consumed",
        ip,
        userAgent: req.headers.get("user-agent"),
      },
      "extension token exchange failed: race-lost or expired",
    );
    return unauthorized();
  }

  // 6. Token issuance. Carry consumed.cnfJkt into the new token so future
  //    DPoP-validated requests verify against the same thumbprint.
  let issued: Awaited<ReturnType<typeof issueExtensionToken>>;
  try {
    issued = await issueExtensionToken({
      userId: consumed.userId,
      tenantId: consumed.tenantId,
      scope: consumed.scope,
      cnfJkt: consumed.cnfJkt,
    });
  } catch (err) {
    await logAuditAsync({
      ...personalAuditBase(req, consumed.userId),
      tenantId: consumed.tenantId,
      action: AUDIT_ACTION.EXTENSION_TOKEN_EXCHANGE_FAILURE,
      metadata: { reason: "issue_failed" },
    });
    getLogger().error(
      {
        event: "extension_token_exchange_failure",
        reason: "issue_failed",
        userId: consumed.userId,
        err,
      },
      "extension token exchange failed: issueExtensionToken threw",
    );
    return errorResponse(API_ERROR.INTERNAL_ERROR);
  }

  // 7. Audit success. cnfJktFingerprint (first 16 hex of SHA-256(cnfJkt))
  //    is carried for forensics without exposing the full thumbprint.
  const cnfJktFingerprint = createHash("sha256")
    .update(consumed.cnfJkt)
    .digest("hex")
    .slice(0, 16);

  await logAuditAsync({
    ...personalAuditBase(req, consumed.userId),
    tenantId: consumed.tenantId,
    action: AUDIT_ACTION.EXTENSION_TOKEN_EXCHANGE_SUCCESS,
    metadata: { cnfJktFingerprint },
  });

  return NextResponse.json(
    {
      token: issued.token,
      expiresAt: issued.expiresAt.toISOString(),
      scope: consumed.scope.split(","),
      cnfJkt: issued.cnfJkt,
    },
    { status: 201, headers: { ...NO_STORE_HEADERS } },
  );
}

export const POST = withRequestLog(handlePOST);
