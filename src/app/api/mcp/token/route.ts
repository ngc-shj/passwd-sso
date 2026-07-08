import { type NextRequest, NextResponse } from "next/server";
import { hashToken } from "@/lib/crypto/crypto-server";
import { readJsonWithCap, readFormWithCap } from "@/lib/http/parse-body";
import { MAX_JSON_BODY_BYTES } from "@/lib/validations/common.server";
import {
  createRefreshToken,
  exchangeCodeForToken,
  exchangeRefreshToken,
  resolveCodeTenantId,
  resolveRefreshTokenGate,
} from "@/lib/mcp/oauth-server";
import { enforceAccessRestriction } from "@/lib/auth/policy/access-restriction";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
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
import { recordPasskeyAuditEmit } from "@/lib/auth/policy/passkey-enforcement";

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

    // Tenant network access restriction (allowedCidrs / Tailscale) — enforced
    // BEFORE the exchange mints, matching the MCP gateway's rule that a leaked
    // credential must still honor the tenant's IP policy. Resolve the code's
    // tenantId read-only; a bad code resolves to null and the exchange below
    // produces the authoritative invalid_grant. The gate only ever restricts.
    const codeTenantId = await resolveCodeTenantId(code);
    if (codeTenantId) {
      const denied = await enforceAccessRestriction(req, SYSTEM_ACTOR_ID, codeTenantId, ACTOR_TYPE.MCP_AGENT);
      if (denied) return denied;
    }

    const clientSecretHash = client_secret ? hashToken(client_secret) : "";

    const result = await exchangeCodeForToken({
      code,
      clientId: client_id,
      clientSecretHash,
      redirectUri: redirect_uri,
      codeVerifier: code_verifier,
    });

    if (!result.ok) {
      // Passkey enforcement at the auth_code → token mint (gated inside
      // exchangeCodeForToken AFTER code validation, BEFORE the access-token
      // create). Emit the block audit + 403.
      if (result.error === "access_denied" && result.userId) {
        if (recordPasskeyAuditEmit(result.userId, "/api/mcp/token", Date.now())) {
          await logAuditAsync({
            ...personalAuditBase(req, result.userId),
            tenantId: result.tenantId,
            action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,
            metadata: { blockedPath: "/api/mcp/token" },
          });
        }
        return NextResponse.json({ error: "access_denied" }, { status: 403 });
      }
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

    // Tenant network access restriction — enforced BEFORE rotation so a stolen
    // refresh token cannot be rotated from an off-network IP (post-rotation denial
    // would strand a legitimate client whose chain was already advanced). Resolve
    // the token's tenantId read-only; an unknown token resolves to null and the
    // exchange produces the authoritative invalid_grant. The gate only restricts.
    //
    // EXCEPTION: a replayed (already-rotated) token skips the IP gate and falls
    // through to exchangeRefreshToken, which revokes the whole family on replay.
    // Gating a replay on IP would 403 before that revocation runs, suppressing the
    // theft alarm for an off-network attacker — the same suppression the mint-point
    // ordering inside exchangeRefreshToken is written to avoid.
    const refreshGate = await resolveRefreshTokenGate(refreshTokenValue);
    if (refreshGate && !refreshGate.alreadyRotated) {
      const denied = await enforceAccessRestriction(req, SYSTEM_ACTOR_ID, refreshGate.tenantId, ACTOR_TYPE.MCP_AGENT);
      if (denied) return denied;
    }

    const result = await exchangeRefreshToken({
      refreshToken: refreshTokenValue,
      clientId: clientIdValue,
      clientSecretHash: clientSecretValue ? hashToken(clientSecretValue) : "",
    });

    if (!result.ok) {
      // Passkey enforcement (gated inside exchangeRefreshToken AFTER replay/
      // revoked/cap validation, BEFORE mint — so a replayed token still revokes
      // its family above). Emit the block audit + 403.
      if (result.error === "access_denied" && result.userId) {
        if (recordPasskeyAuditEmit(result.userId, "/api/mcp/token", Date.now())) {
          await logAuditAsync({
            ...personalAuditBase(req, result.userId),
            tenantId: result.tenantId,
            action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,
            metadata: { blockedPath: "/api/mcp/token" },
          });
        }
        return NextResponse.json({ error: "access_denied" }, { status: 403 });
      }
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
