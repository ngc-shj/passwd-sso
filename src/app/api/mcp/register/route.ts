import { type NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { hashToken } from "@/lib/crypto/crypto-server";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { extractClientIp, rateLimitKeyFromIp } from "@/lib/auth/ip-access";
import { logAuditAsync } from "@/lib/audit/audit";
import { AUDIT_SCOPE, AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit";
import { AUDIT_TARGET_TYPE } from "@/lib/constants/audit-target";
import {
  MCP_CLIENT_ID_PREFIX,
  MCP_SCOPES,
  MCP_DCR_UNCLAIMED_EXPIRY_SEC,
  MAX_UNCLAIMED_DCR_CLIENTS,
  DCR_RATE_LIMIT_WINDOW_MS,
  DCR_RATE_LIMIT_MAX,
} from "@/lib/constants/mcp";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { withRequestLog } from "@/lib/with-request-log";

const dcrRateLimiter = createRateLimiter({
  windowMs: DCR_RATE_LIMIT_WINDOW_MS,
  max: DCR_RATE_LIMIT_MAX,
});

// Loopback redirect URIs: allow both the loopback IP literals and localhost with a port.
// RFC 8252 §7.3 specifies loopback IP literals (127.0.0.1 / [::1]); §8.3 marks
// localhost as NOT RECOMMENDED, but real clients (Claude Code) use it.
const LOOPBACK_REDIRECT_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//;

const dcrSchema = z.object({
  client_name: z.string().min(1).max(100),
  redirect_uris: z
    .array(z.string().url())
    .min(1)
    .max(10)
    .refine(
      (uris) =>
        uris.every((u) => {
          try {
            const url = new URL(u);
            return url.protocol === "https:" || LOOPBACK_REDIRECT_RE.test(u);
          } catch {
            return false;
          }
        }),
      {
        message:
          "redirect_uris must use https:// or http://localhost:<port>/ or http://127.0.0.1:<port>/",
      },
    ),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
  scope: z.string().optional(), // Space-separated scopes (ignored, server controls scopes)
});

async function handlePOST(req: NextRequest) {
  // Rate limit by client IP (/64 prefix for IPv6)
  const ip = extractClientIp(req);
  const rl = await dcrRateLimiter.check(
    `rl:mcp:dcr:${rateLimitKeyFromIp(ip ?? "unknown")}`,
  );
  if (!rl.allowed) {
    const retryAfter = Math.ceil((rl.retryAfterMs ?? DCR_RATE_LIMIT_WINDOW_MS) / 1000);
    return NextResponse.json(
      { error: "rate_limit_exceeded" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  // Parse and validate request body
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const parsed = dcrSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_client_metadata", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const body = parsed.data;

  // Validate grant_types: if provided, must include authorization_code
  if (body.grant_types && !body.grant_types.includes("authorization_code")) {
    return NextResponse.json(
      {
        error: "invalid_client_metadata",
        error_description: "grant_types must include authorization_code",
      },
      { status: 400 },
    );
  }

  // Validate response_types: if provided, must include code
  if (body.response_types && !body.response_types.includes("code")) {
    return NextResponse.json(
      {
        error: "invalid_client_metadata",
        error_description: "response_types must include code",
      },
      { status: 400 },
    );
  }

  const tokenEndpointAuthMethod =
    body.token_endpoint_auth_method ?? "client_secret_post";
  const isPublicClient = tokenEndpointAuthMethod === "none";
  const validatedUris = body.redirect_uris;

  // Generate client credentials (public clients don't get a secret)
  const clientId = MCP_CLIENT_ID_PREFIX + randomBytes(16).toString("hex");
  const clientSecret = isPublicClient ? null : randomBytes(32).toString("base64url");
  const clientSecretHash = clientSecret ? hashToken(clientSecret) : "";
  const dcrExpiresAt = new Date(Date.now() + MCP_DCR_UNCLAIMED_EXPIRY_SEC * 1000);

  // Count + create atomically with bypass RLS (no tenant context for DCR)
  let client: { id: string; clientId: string; createdAt: Date };
  try {
    client = await withBypassRls(prisma, async () =>
      prisma.$transaction(async (tx) => {
        // Global cap: reject if too many unclaimed DCR clients exist
        const unclaimedCount = await tx.mcpClient.count({
          where: { isDcr: true, tenantId: null },
        });
        if (unclaimedCount >= MAX_UNCLAIMED_DCR_CLIENTS) {
          throw new CapExceededError();
        }

        return tx.mcpClient.create({
          data: {
            clientId,
            clientSecretHash,
            name: body.client_name,
            redirectUris: validatedUris,
            allowedScopes: MCP_SCOPES.join(","),
            isDcr: true,
            dcrExpiresAt,
            // tenantId: null (omitted)
            // createdById: null (omitted)
          },
          select: { id: true, clientId: true, createdAt: true },
        });
      }),
    BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
  } catch (err) {
    if (err instanceof CapExceededError) {
      return NextResponse.json(
        { error: "temporarily_unavailable", error_description: "Global DCR client cap reached" },
        { status: 503 },
      );
    }
    throw err;
  }

  // Piggyback cleanup: probabilistically delete expired unclaimed clients (~10% of requests)
  if (Math.random() < 0.1) {
    prisma.mcpClient
      .deleteMany({
        where: { isDcr: true, tenantId: null, dcrExpiresAt: { lt: new Date() } },
      })
      .catch(() => {}); // fire-and-forget
  }

  // Audit log — system-level, no tenant or user context
  await logAuditAsync({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.MCP_CLIENT_DCR_REGISTER,
    userId: SYSTEM_ACTOR_ID,
    actorType: ACTOR_TYPE.SYSTEM,
    targetType: AUDIT_TARGET_TYPE.MCP_CLIENT,
    targetId: client.id,
    metadata: { client_name: body.client_name, clientId: client.clientId },
    ip,
  });

  const responseBody: Record<string, unknown> = {
    client_id: client.clientId,
    client_name: body.client_name,
    redirect_uris: validatedUris,
    grant_types: body.grant_types ?? ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: tokenEndpointAuthMethod,
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
  };
  if (clientSecret) {
    responseBody.client_secret = clientSecret;
    responseBody.client_secret_expires_at = 0;
  }

  return NextResponse.json(responseBody, { status: 201 });
}

class CapExceededError extends Error {}

export const POST = withRequestLog(handlePOST);
