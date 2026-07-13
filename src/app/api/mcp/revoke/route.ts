import { type NextRequest, NextResponse } from "next/server";
import { revokeToken } from "@/lib/mcp/oauth-server";
import { hashToken } from "@/lib/crypto/crypto-server";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { extractClientIp } from "@/lib/auth/policy/ip-access";
import { checkIpRateLimit } from "@/lib/security/ip-rate-limit";
import { readJsonWithCap, readFormWithCap } from "@/lib/http/parse-body";
import { MAX_JSON_BODY_BYTES } from "@/lib/validations/common.server";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { MS_PER_MINUTE, MS_PER_SECOND } from "@/lib/constants/time";
import {
  MCP_CLIENT_ID_MAX_LENGTH,
  MCP_CLIENT_SECRET_MAX_LENGTH,
  MCP_PRESENTED_TOKEN_MAX_LENGTH,
  MCP_TOKEN_TYPE_HINT_MAX_LENGTH,
} from "@/lib/constants/auth/mcp";
import { z } from "zod";

const revokeLimiter = createRateLimiter({
  windowMs: MS_PER_MINUTE,
  max: 30,
  failClosedOnRedisError: true,
});

const RevokeRequestSchema = z.object({
  token: z.string().min(1).max(MCP_PRESENTED_TOKEN_MAX_LENGTH),
  token_type_hint: z.string().max(MCP_TOKEN_TYPE_HINT_MAX_LENGTH).optional(),
  client_id: z.string().min(1).max(MCP_CLIENT_ID_MAX_LENGTH),
  client_secret: z.string().max(MCP_CLIENT_SECRET_MAX_LENGTH).optional(),
});

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
  const rl = await checkIpRateLimit({
    ip: extractClientIp(req),
    pathname: req.nextUrl.pathname,
    scope: "mcp_revoke",
    limiter: revokeLimiter,
  });
  const blocked = await checkRateLimitOrFail({
    req,
    result: rl,
    scope: "mcp.revoke",
    userId: null,
    envelope: "oauth",
    rateLimitedEnvelope: (retryAfterMs) =>
      NextResponse.json(
        { error: "rate_limited" },
        {
          status: 429,
          // Default 60 s when retryAfterMs is null/undefined — preserves the
          // pre-migration contract (see route.test.ts: "defaulting to 60").
          headers: {
            "Retry-After": String(Math.ceil((retryAfterMs ?? MS_PER_MINUTE) / MS_PER_SECOND)),
          },
        },
      ),
  });
  if (blocked) return blocked;

  let rawBody: unknown;
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    // Stream-read the untrusted form body under the byte cap. The streaming cap
    // is authoritative — it defends against chunked bodies that omit
    // Content-Length, which a bare header pre-check cannot.
    const read = await readFormWithCap(req, MAX_JSON_BODY_BYTES);
    if (!read.ok) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    rawBody = Object.fromEntries(new URLSearchParams(read.text));
  } else {
    const read = await readJsonWithCap(req, MAX_JSON_BODY_BYTES);
    if (!read.ok) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    rawBody = read.body;
  }

  const parsed = RevokeRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const body = parsed.data;
  const token = body.token;
  // RFC 7009 §2.1: an unsupported hint is ignored (try both token types), so
  // map only the two known values through and drop anything else to undefined.
  const tokenTypeHint =
    body.token_type_hint === "access_token" || body.token_type_hint === "refresh_token"
      ? body.token_type_hint
      : undefined;
  const clientId = body.client_id;

  const clientSecret = body.client_secret;
  const clientSecretHash = clientSecret ? hashToken(clientSecret) : undefined;

  await revokeToken({ token, tokenTypeHint, clientId, clientSecretHash });

  // RFC 7009 §2.2: always 200
  return new NextResponse(null, { status: 200 });
}
