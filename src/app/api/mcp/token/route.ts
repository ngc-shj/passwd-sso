import { type NextRequest, NextResponse } from "next/server";
import { hashToken } from "@/lib/crypto/crypto-server";
import { readJsonWithCap, readFormWithCap } from "@/lib/http/parse-body";
import { MAX_JSON_BODY_BYTES } from "@/lib/validations/common.server";
import {
  createRefreshToken,
  exchangeCodeForToken,
  exchangeRefreshToken,
} from "@/lib/mcp/oauth-server";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { extractClientIp, rateLimitKeyFromIp } from "@/lib/auth/policy/ip-access";
import { logAuditAsync, tenantAuditBase, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { resolveAuditUserId } from "@/lib/constants/app";
import {
  REFRESH_EXCHANGE_REASON,
  FAMILY_REVOKED_REASON,
} from "@/lib/constants/auth/mcp";
import { withRequestLog } from "@/lib/http/with-request-log";
import { NO_STORE_HEADERS } from "@/lib/http/cache-headers";
import { MS_PER_MINUTE, MS_PER_SECOND } from "@/lib/constants/time";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import {
  derivePasskeyState,
  passkeyEnforcementBlocks,
  recordPasskeyAuditEmit,
} from "@/lib/auth/policy/passkey-enforcement";

const tokenRateLimiter = createRateLimiter({
  windowMs: MS_PER_MINUTE,
  max: 10,
  failClosedOnRedisError: true,
});
const ipRateLimiter = createRateLimiter({
  windowMs: MS_PER_MINUTE,
  max: 30,
  failClosedOnRedisError: true,
});

async function handlePOST(req: NextRequest) {
  let body: Record<string, string>;
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    // Stream-read the untrusted form body under the byte cap. The streaming cap
    // is authoritative — it defends against chunked bodies that omit
    // Content-Length, which a bare header pre-check cannot.
    const read = await readFormWithCap(req, MAX_JSON_BODY_BYTES);
    if (!read.ok) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    body = Object.fromEntries(new URLSearchParams(read.text));
  } else {
    const read = await readJsonWithCap(req, MAX_JSON_BODY_BYTES);
    if (!read.ok) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    body = read.body as Record<string, string>;
  }

  const grantType = body.grant_type;

  // IP rate limit applies to all grant types
  const ip = extractClientIp(req);
  if (ip) {
    const blocked = await checkRateLimitOrFail({
      req,
      limiter: ipRateLimiter,
      key: `rl:mcp:token:ip:${rateLimitKeyFromIp(ip)}`,
      scope: "mcp.token_ip",
      userId: null,
      envelope: "oauth",
      rateLimitedEnvelope: (retryAfterMs) =>
        NextResponse.json(
          { error: "slow_down" },
          {
            status: 429,
            headers:
              retryAfterMs != null && retryAfterMs > 0
                ? { "Retry-After": String(Math.ceil(retryAfterMs / MS_PER_SECOND)) }
                : {},
          },
        ),
    });
    if (blocked) return blocked;
  }

  if (grantType === "authorization_code") {
    const { code, redirect_uri, client_id, client_secret, code_verifier } = body;

    // client_secret is optional for public clients (token_endpoint_auth_method: "none")
    if (!code || !redirect_uri || !client_id || !code_verifier) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }

    const blocked = await checkRateLimitOrFail({
      req,
      limiter: tokenRateLimiter,
      key: `mcp:token:${client_id}`,
      scope: "mcp.token",
      userId: null,
      envelope: "oauth",
      rateLimitedEnvelope: (retryAfterMs) =>
        NextResponse.json(
          { error: "slow_down" },
          {
            status: 429,
            headers:
              retryAfterMs != null && retryAfterMs > 0
                ? { "Retry-After": String(Math.ceil(retryAfterMs / MS_PER_SECOND)) }
                : {},
          },
        ),
    });
    if (blocked) return blocked;

    const clientSecretHash = client_secret ? hashToken(client_secret) : "";

    const result = await exchangeCodeForToken({
      code,
      clientId: client_id,
      clientSecretHash,
      redirectUri: redirect_uri,
      codeVerifier: code_verifier,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    const { refreshToken } = await createRefreshToken({
      accessTokenId: result.data.tokenId,
      clientId: result.data.clientDbId,
      tenantId: result.data.tenantId,
      userId: result.data.userId,
      serviceAccountId: result.data.serviceAccountId,
      scope: result.data.scope,
    });

    return NextResponse.json({
      access_token: result.data.accessToken,
      token_type: result.data.tokenType,
      expires_in: result.data.expiresIn,
      refresh_token: refreshToken,
      scope: result.data.scope.replace(/,/g, " "),
    }, { headers: { ...NO_STORE_HEADERS } });
  } else if (grantType === "refresh_token") {
    const refreshTokenValue = body.refresh_token;
    const clientIdValue = body.client_id;
    const clientSecretValue = body.client_secret;

    // client_secret is optional for public clients (token_endpoint_auth_method: "none")
    if (!refreshTokenValue || !clientIdValue) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }

    const blocked = await checkRateLimitOrFail({
      req,
      limiter: tokenRateLimiter,
      key: `mcp:token:${clientIdValue}`,
      scope: "mcp.token",
      userId: null,
      envelope: "oauth",
      rateLimitedEnvelope: (retryAfterMs) =>
        NextResponse.json(
          { error: "slow_down" },
          {
            status: 429,
            headers:
              retryAfterMs != null && retryAfterMs > 0
                ? { "Retry-After": String(Math.ceil(retryAfterMs / MS_PER_SECOND)) }
                : {},
          },
        ),
    });
    if (blocked) return blocked;

    // C8: Passkey enforcement gate — pre-read the refresh-token row inside
    // withBypassRls so RLS does not filter it to null for a cookieless request.
    // Use the same hashToken call that exchangeRefreshToken uses internally.
    const refreshTokenHash = hashToken(refreshTokenValue);
    const passkeyGateResult = await withBypassRls(
      prisma,
      async (tx) => {
        const rt = await tx.mcpRefreshToken.findUnique({
          where: { tokenHash: refreshTokenHash },
          select: { userId: true, tenantId: true },
        });
        // Row not found: let exchangeRefreshToken handle the invalid_grant.
        if (!rt) return { blocked: false as const };
        // SA-bound token (userId === null): skip passkey gate; rotate normally.
        if (rt.userId === null) return { blocked: false as const };
        // User-bound: re-derive passkey state with the bypass tx and gate.
        const state = await derivePasskeyState({ userId: rt.userId, tenantId: rt.tenantId, tx });
        if (passkeyEnforcementBlocks(state)) {
          return { blocked: true as const, userId: rt.userId, tenantId: rt.tenantId };
        }
        return { blocked: false as const };
      },
      BYPASS_PURPOSE.TOKEN_LIFECYCLE,
    );
    if (passkeyGateResult.blocked) {
      if (recordPasskeyAuditEmit(passkeyGateResult.userId, "/api/mcp/token", Date.now())) {
        await logAuditAsync({
          ...personalAuditBase(req, passkeyGateResult.userId),
          tenantId: passkeyGateResult.tenantId,
          action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,
          metadata: { blockedPath: "/api/mcp/token" },
        });
      }
      return NextResponse.json({ error: "access_denied" }, { status: 403 });
    }

    const result = await exchangeRefreshToken({
      refreshToken: refreshTokenValue,
      clientId: clientIdValue,
      clientSecretHash: clientSecretValue ? hashToken(clientSecretValue) : "",
    });

    if (!result.ok) {
      if (result.reason === REFRESH_EXCHANGE_REASON.REPLAY && result.tenantId) {
        await logAuditAsync({
          ...tenantAuditBase(req, resolveAuditUserId(null, "system"), result.tenantId),
          action: AUDIT_ACTION.MCP_REFRESH_TOKEN_REPLAY,
          actorType: ACTOR_TYPE.SYSTEM,
          metadata: {
            clientId: clientIdValue,
            familyId: result.familyId,
            reason: FAMILY_REVOKED_REASON.REPLAY,
          },
        });
      }
      if (
        result.reason === REFRESH_EXCHANGE_REASON.CONCURRENT_ROTATION_REVOKED &&
        result.tenantId
      ) {
        await logAuditAsync({
          ...tenantAuditBase(req, resolveAuditUserId(null, "system"), result.tenantId),
          action: AUDIT_ACTION.MCP_REFRESH_TOKEN_FAMILY_REVOKED,
          actorType: ACTOR_TYPE.SYSTEM,
          metadata: {
            clientId: clientIdValue,
            familyId: result.familyId,
            reason: FAMILY_REVOKED_REASON.CONCURRENT_ROTATION,
          },
        });
      }
      return NextResponse.json(
        { error: result.error },
        { status: result.error === "invalid_client" ? 401 : 400 },
      );
    }

    await logAuditAsync({
      ...tenantAuditBase(req, resolveAuditUserId(result.userId, "system"), result.tenantId),
      action: AUDIT_ACTION.MCP_REFRESH_TOKEN_ROTATE,
      actorType: result.userId ? ACTOR_TYPE.MCP_AGENT : ACTOR_TYPE.SYSTEM,
      metadata: { clientId: clientIdValue },
    });

    return NextResponse.json({
      access_token: result.accessToken,
      token_type: "Bearer",
      expires_in: result.expiresIn,
      refresh_token: result.refreshToken,
      scope: result.scope.replace(/,/g, " "),
    }, { headers: { ...NO_STORE_HEADERS } });
  } else {
    return NextResponse.json({ error: "unsupported_grant_type" }, { status: 400 });
  }
}

export const POST = withRequestLog(handlePOST);
