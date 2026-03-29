import { type NextRequest, NextResponse } from "next/server";
import { hashToken } from "@/lib/crypto-server";
import {
  createRefreshToken,
  exchangeCodeForToken,
  exchangeRefreshToken,
} from "@/lib/mcp/oauth-server";
import { createRateLimiter } from "@/lib/rate-limit";
import { extractClientIp, rateLimitKeyFromIp } from "@/lib/ip-access";
import { logAudit } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants/audit";

const tokenRateLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });
const ipRateLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

export async function POST(req: NextRequest) {
  let body: Record<string, string>;
  const contentType = req.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const text = await req.text();
      body = Object.fromEntries(new URLSearchParams(text));
    } else {
      body = await req.json() as Record<string, string>;
    }
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const grantType = body.grant_type;

  // IP rate limit applies to all grant types
  const ip = extractClientIp(req);
  if (ip) {
    const ipRl = await ipRateLimiter.check(`rl:mcp:token:ip:${rateLimitKeyFromIp(ip)}`);
    if (!ipRl.allowed) {
      const retryAfter = Math.ceil((ipRl.retryAfterMs ?? 60_000) / 1000);
      return NextResponse.json(
        { error: "slow_down" },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }
  }

  if (grantType === "authorization_code") {
    const { code, redirect_uri, client_id, client_secret, code_verifier } = body;

    if (!code || !redirect_uri || !client_id || !client_secret || !code_verifier) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }

    const rl = await tokenRateLimiter.check(`mcp:token:${client_id}`);
    if (!rl.allowed) {
      const retryAfter = Math.ceil((rl.retryAfterMs ?? 60_000) / 1000);
      return NextResponse.json(
        { error: "slow_down" },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }

    const clientSecretHash = hashToken(client_secret);

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
    });
  } else if (grantType === "refresh_token") {
    const refreshTokenValue = body.refresh_token;
    const clientIdValue = body.client_id;
    const clientSecretValue = body.client_secret;

    if (!refreshTokenValue || !clientIdValue || !clientSecretValue) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }

    const clientRl = await tokenRateLimiter.check(`mcp:token:${clientIdValue}`);
    if (!clientRl.allowed) {
      const retryAfter = Math.ceil((clientRl.retryAfterMs ?? 60_000) / 1000);
      return NextResponse.json(
        { error: "slow_down" },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }

    const result = await exchangeRefreshToken({
      refreshToken: refreshTokenValue,
      clientId: clientIdValue,
      clientSecretHash: hashToken(clientSecretValue),
    });

    if (!result.ok) {
      if (result.reason === "replay") {
        logAudit({
          scope: AUDIT_SCOPE.TENANT,
          action: AUDIT_ACTION.MCP_REFRESH_TOKEN_REPLAY,
          userId: "system",
          tenantId: "unknown",
          metadata: { clientId: clientIdValue },
        });
      }
      return NextResponse.json(
        { error: result.error },
        { status: result.error === "invalid_client" ? 401 : 400 },
      );
    }

    logAudit({
      scope: AUDIT_SCOPE.TENANT,
      action: AUDIT_ACTION.MCP_REFRESH_TOKEN_ROTATE,
      userId: result.userId ?? "system",
      tenantId: result.tenantId,
      metadata: { clientId: clientIdValue },
    });

    return NextResponse.json({
      access_token: result.accessToken,
      token_type: "Bearer",
      expires_in: result.expiresIn,
      refresh_token: result.refreshToken,
      scope: result.scope.replace(/,/g, " "),
    });
  } else {
    return NextResponse.json({ error: "unsupported_grant_type" }, { status: 400 });
  }
}
