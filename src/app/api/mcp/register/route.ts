import { type NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { readJsonWithCap } from "@/lib/http/parse-body";
import { MAX_JSON_BODY_BYTES } from "@/lib/validations/common.server";
import { extractClientIp, rateLimitKeyFromIp } from "@/lib/auth/policy/ip-access";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { logAuditAsync } from "@/lib/audit/audit";
import { AUDIT_SCOPE, AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { AUDIT_TARGET_TYPE } from "@/lib/constants/audit/audit-target";
import {
  MCP_CLIENT_ID_PREFIX,
  MCP_SCOPES,
  MCP_DCR_UNCLAIMED_EXPIRY_SEC,
  MAX_UNCLAIMED_DCR_CLIENTS,
  DCR_RATE_LIMIT_WINDOW_MS,
  DCR_RATE_LIMIT_MAX,
  LOOPBACK_REDIRECT_RE,
} from "@/lib/constants/auth/mcp";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { withRequestLog } from "@/lib/http/with-request-log";

const dcrRateLimiter = createRateLimiter({
  windowMs: DCR_RATE_LIMIT_WINDOW_MS,
  max: DCR_RATE_LIMIT_MAX,
  failClosedOnRedisError: true,
});

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
          "redirect_uris must use https:// or http://(127.0.0.1|localhost|[::1]):<port>/",
      },
    ),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  // A07-4: RFC 9700 §4.14 — DCR clients are public-only (untrusted registrants).
  // Confidential clients must be created via /api/tenant/mcp-clients (admin only).
  // Required, exact literal "none" — no default fallback, no case/whitespace
  // tolerance. Wrong-shape inputs (null, array, number) also fail Zod parsing.
  token_endpoint_auth_method: z.literal("none", {
    error: () =>
      "token_endpoint_auth_method must be 'none' (DCR issues public clients only — RFC 9700 §4.14)",
  }),
  scope: z.string().optional(), // Space-separated scopes (ignored, server controls scopes)
});

async function handlePOST(req: NextRequest) {
  // Rate limit by client IP (/64 prefix for IPv6)
  const ip = extractClientIp(req);
  const blocked = await checkRateLimitOrFail({
    req,
    limiter: dcrRateLimiter,
    key: `rl:mcp:dcr:${rateLimitKeyFromIp(ip ?? "unknown")}`,
    scope: "mcp.dcr_register",
    userId: null,
    envelope: "oauth",
    rateLimitedEnvelope: () =>
      NextResponse.json({ error: "rate_limit_exceeded" }, { status: 429 }),
  });
  if (blocked) return blocked;

  // Parse and validate request body (byte-capped; pre-auth endpoint).
  // RFC 7591 error format required ({ error: "invalid_request" } per RFC 6749 §5.2).
  const read = await readJsonWithCap(req, MAX_JSON_BODY_BYTES);
  if (!read.ok) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const parsed = dcrSchema.safeParse(read.body);
  if (!parsed.success) {
    // Lift the first issue's message into error_description so RFC 9700 reference
    // surfaces in the standard RFC 6749 §5.2 error envelope.
    const firstIssue = parsed.error.issues[0];
    return NextResponse.json(
      {
        error: "invalid_client_metadata",
        error_description: firstIssue?.message ?? "Invalid client metadata",
        issues: parsed.error.issues,
      },
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

  const validatedUris = body.redirect_uris;

  // A07-4: DCR issues public clients only — no secret generation.
  // clientSecretHash is NOT NULL on the schema; empty string is the public-client
  // sentinel (matches downstream `clientSecretHash === ""` check in oauth-server.ts).
  const clientId = MCP_CLIENT_ID_PREFIX + randomBytes(16).toString("hex");
  const clientSecretHash = "";
  const dcrExpiresAt = new Date(Date.now() + MCP_DCR_UNCLAIMED_EXPIRY_SEC * 1000);

  // Count + create atomically with bypass RLS (no tenant context for DCR)
  let client: { id: string; clientId: string; createdAt: Date };
  try {
    client = await withBypassRls(prisma, async (tx) =>
      prisma.$transaction(async (tx) => {
        // Lazy cleanup: drop expired unclaimed clients before counting so the
        // global cap cannot stay exhausted when dcr-cleanup-worker is down
        // (otherwise a burst of registrations would deny DCR service-wide
        // until the worker drains them).
        await tx.mcpClient.deleteMany({
          where: { isDcr: true, tenantId: null, dcrExpiresAt: { lt: new Date() } },
        });

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
        {
          error: "temporarily_unavailable",
          error_description:
            "Global DCR client cap reached — ensure dcr-cleanup-worker is running.",
        },
        { status: 503 },
      );
    }
    throw err;
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
    token_endpoint_auth_method: "none", // A07-4: literal — DCR is public-only
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
  };

  return NextResponse.json(responseBody, { status: 201 });
}

class CapExceededError extends Error {}

export const POST = withRequestLog(handlePOST);
