import { type NextRequest, NextResponse } from "next/server";
import { revokeToken } from "@/lib/mcp/oauth-server";
import { hashToken } from "@/lib/crypto/crypto-server";
import { createRateLimiter } from "@/lib/rate-limit";
import { extractClientIp, rateLimitKeyFromIp } from "@/lib/auth/ip-access";

const revokeLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

/**
 * POST /api/mcp/revoke — OAuth 2.0 Token Revocation (RFC 7009)
 *
 * Body (application/x-www-form-urlencoded):
 *   token           — REQUIRED: the token to revoke
 *   token_type_hint — OPTIONAL: "access_token" or "refresh_token"
 *   client_id       — REQUIRED for public clients
 *
 * Always returns 200 per RFC 7009 §2.2 (even for invalid tokens).
 */
export async function POST(req: NextRequest) {
  const ip = extractClientIp(req) ?? "unknown";
  const rl = await revokeLimiter.check(`rl:mcp_revoke:${rateLimitKeyFromIp(ip)}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.retryAfterMs ?? 60_000) / 1000)) } },
    );
  }

  let body: Record<string, string>;
  const contentType = req.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const text = await req.text();
      body = Object.fromEntries(new URLSearchParams(text));
    } else {
      body = (await req.json()) as Record<string, string>;
    }
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const token = body.token;
  const tokenTypeHint = body.token_type_hint as "access_token" | "refresh_token" | undefined;
  const clientId = body.client_id;

  if (!token || !clientId) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  if (tokenTypeHint && tokenTypeHint !== "access_token" && tokenTypeHint !== "refresh_token") {
    // RFC 7009 §2.1: unsupported token type → ignore hint, try both
  }

  const clientSecret = body.client_secret;
  const clientSecretHash = clientSecret ? hashToken(clientSecret) : undefined;

  await revokeToken({ token, tokenTypeHint, clientId, clientSecretHash });

  // RFC 7009 §2.2: always 200
  return new NextResponse(null, { status: 200 });
}
