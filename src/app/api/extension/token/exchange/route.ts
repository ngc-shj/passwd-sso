/**
 * POST /api/extension/token/exchange — Exchange a one-time bridge code for a token.
 *
 * Step 5 of the extension-bridge-code-exchange plan. Called from the extension
 * content script (isolated world) after it receives a bridge code via
 * `window.postMessage`. The endpoint:
 *
 * 1. Validates the request body (64-char hex code)
 * 2. Rate-limits per client IP (no session is available at this point)
 * 3. Atomically consumes the code (single UPDATE + count check)
 * 4. Resolves userId/tenantId/scope from the consumed code record
 *    (server-side resolution — never from client input, P1-S1)
 * 5. Issues an extension token via the shared `issueExtensionToken()` helper
 * 6. Logs success via `logAudit`; logs failures via pino directly
 *    (Considerations §7 — `logAudit` requires a resolvable user/tenant)
 *
 * No Auth.js session and no Origin check by design — the extension content
 * script's effective origin in fetch headers may be `chrome-extension://`,
 * which would fail `assertOrigin`. Compensating control: 256-bit single-use
 * short-lived bridge code.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto-server";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import {
  errorResponse,
  rateLimited,
  unauthorized,
  zodValidationError,
} from "@/lib/api-response";
import { issueExtensionToken } from "@/lib/extension-token";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { extractClientIp } from "@/lib/ip-access";
import { logAuditAsync } from "@/lib/audit";
import { getLogger } from "@/lib/logger";
import { withRequestLog } from "@/lib/with-request-log";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { MS_PER_MINUTE } from "@/lib/constants/time";

export const runtime = "nodejs";

const exchangeLimiter = createRateLimiter({
  windowMs: 15 * MS_PER_MINUTE,
  max: 10,
});

const ExchangeRequestSchema = z.object({
  code: z.string().length(64).regex(/^[a-f0-9]+$/),
});

async function handlePOST(req: NextRequest) {
  // Parse request body
  const body = await req.json().catch(() => null);
  const parsed = ExchangeRequestSchema.safeParse(body);
  if (!parsed.success) {
    // No user context — pino-only logging (audit requires resolvable user/tenant)
    getLogger().warn(
      {
        event: "extension_token_exchange_failure",
        reason: "invalid_request",
        ip: extractClientIp(req),
        userAgent: req.headers.get("user-agent"),
      },
      "extension token exchange failed: malformed body",
    );
    return zodValidationError(parsed.error);
  }

  const { code } = parsed.data;

  // Rate limit BEFORE DB lookup (keyed by client IP, no session available).
  // Compensating control: 256-bit code entropy makes brute force infeasible.
  const ip = extractClientIp(req) ?? "unknown";
  const rl = await exchangeLimiter.check(`rl:ext_exchange:${ip}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  // Atomic consume: single UPDATE with affected-rows check
  const codeHash = hashToken(code);
  const now = new Date();
  const result = await withBypassRls(
    prisma,
    async () =>
      prisma.extensionBridgeCode.updateMany({
        where: {
          codeHash,
          usedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      }),
    BYPASS_PURPOSE.TOKEN_LIFECYCLE,
  );

  if (result.count === 0) {
    // Either code unknown, already used, or expired — same response for all cases.
    // Pino-only: no resolvable user/tenant for the failure case.
    getLogger().warn(
      {
        event: "extension_token_exchange_failure",
        reason: "unknown_or_consumed",
        ip,
        userAgent: req.headers.get("user-agent"),
      },
      "extension token exchange failed: code unknown, expired, or already consumed",
    );
    return unauthorized();
  }

  // Fetch the consumed code to resolve userId/tenantId/scope from server data
  // (P1-S1: server-side resolution, never from client input).
  const consumed = await withBypassRls(
    prisma,
    async () =>
      prisma.extensionBridgeCode.findUnique({
        where: { codeHash },
        select: { userId: true, tenantId: true, scope: true },
      }),
    BYPASS_PURPOSE.TOKEN_LIFECYCLE,
  );

  if (!consumed) {
    // System invariant violation: the UPDATE just succeeded but findUnique
    // returned null. Log loudly so we can debug if this ever fires.
    // Cannot emit logAudit here because we have no resolvable userId/tenantId
    // (the consumed record literally just disappeared).
    getLogger().error(
      {
        event: "extension_token_exchange_invariant_violation",
        codeHash,
      },
      "consumed code not found after successful update — system invariant violated",
    );
    return errorResponse(API_ERROR.INTERNAL_ERROR, 500);
  }

  // Issue ExtensionToken via shared helper (same logic as legacy POST /api/extension/token).
  // Wrap in try/catch so a token-issuance failure on this branch (where we DO have a
  // resolvable userId/tenantId from the consumed code record) is recorded as an audit
  // event, not just a swallowed 500.
  let issued: Awaited<ReturnType<typeof issueExtensionToken>>;
  try {
    issued = await issueExtensionToken({
      userId: consumed.userId,
      tenantId: consumed.tenantId,
      scope: consumed.scope,
    });
  } catch (err) {
    await logAuditAsync({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.EXTENSION_TOKEN_EXCHANGE_FAILURE,
      userId: consumed.userId,
      tenantId: consumed.tenantId,
      ip,
      userAgent: req.headers.get("user-agent"),
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
    return errorResponse(API_ERROR.INTERNAL_ERROR, 500);
  }

  // Audit success: userId and tenantId both come from the consumed code record
  await logAuditAsync({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.EXTENSION_TOKEN_EXCHANGE_SUCCESS,
    userId: consumed.userId,
    tenantId: consumed.tenantId,
    ip,
    userAgent: req.headers.get("user-agent"),
  });

  return NextResponse.json(
    {
      token: issued.token,
      expiresAt: issued.expiresAt.toISOString(),
      scope: consumed.scope.split(","),
    },
    { status: 201 },
  );
}

export const POST = withRequestLog(handlePOST);
