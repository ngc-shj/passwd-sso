/**
 * GET /api/mobile/favicon?host=&size=<32|64>
 *
 * iOS-DPoP-authenticated favicon proxy. Reuses the same cache, single-flight
 * deduplication, SSRF-safe fetch, and MIME allowlist as the web route
 * (/api/user/favicon). The only differences are the auth path (DPoP bearer
 * via validateExtensionToken instead of Auth.js session) and the IOS_APP
 * clientKind guard.
 *
 * Auth: validateExtensionToken (dispatches to DPoP for IOS_APP rows).
 * Opt-in: User.fetchFavicons must be true; read via withTenantRls to enforce RLS.
 * Rate limit: shared FAVICON_USER_RATE_MAX / FAVICON_GLOBAL_RATE_MAX constants,
 *   keys rl:favicon:<userId> and rl:favicon:global (same as the web route).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { validateExtensionToken } from "@/lib/auth/tokens/extension-token";
import { enforceAccessRestriction } from "@/lib/auth/policy/access-restriction";
import { withTenantRls } from "@/lib/tenant-rls";
import { validateAndFetchBuffered } from "@/lib/http/external-http";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { parseQuery } from "@/lib/http/parse-body";
import { API_ERROR } from "@/lib/http/api-error-codes";
import {
  errorResponse,
  rateLimited,
  forbidden,
  validationError,
} from "@/lib/http/api-response";
import { withRequestLog } from "@/lib/http/with-request-log";
import { RATE_WINDOW_MS } from "@/lib/validations/common.server";
import { SEC_PER_HOUR } from "@/lib/constants/time";
import {
  normalizeFaviconHost,
  buildFaviconProviderUrl,
  getCachedFavicon,
  setCachedFavicon,
  withSingleFlight,
  isAllowedFaviconMime,
  FAVICON_MAX_BODY_BYTES,
  faviconResponse,
  FAVICON_USER_RATE_MAX,
  FAVICON_GLOBAL_RATE_MAX,
} from "@/lib/favicon/favicon-proxy";

export const runtime = "nodejs";

const faviconQuerySchema = z.object({
  host: z.string(),
  size: z.enum(["32", "64"]),
});

// Fail-open limiters: favicon is a cosmetic feature — a Redis blip must not 503.
// Keys and maxes are shared with the web route so both paths count against the
// same per-user and global bucket.
const userLimiter = createRateLimiter({
  windowMs: RATE_WINDOW_MS,
  max: FAVICON_USER_RATE_MAX,
});

const globalLimiter = createRateLimiter({
  windowMs: RATE_WINDOW_MS,
  max: FAVICON_GLOBAL_RATE_MAX,
});

async function handleGET(req: NextRequest): Promise<Response> {
  // 1. Token authentication (DPoP for IOS_APP rows)
  const auth = await validateExtensionToken(req);
  if (!auth.ok) {
    return errorResponse(API_ERROR[auth.error], 401);
  }
  const { userId, tenantId, clientKind } = auth.data;

  // 2. IOS_APP guard — only the host app may call this endpoint
  if (clientKind !== "IOS_APP") {
    return forbidden();
  }

  // 3. Tenant network-boundary enforcement
  const denied = await enforceAccessRestriction(req, userId, tenantId);
  if (denied) return denied;

  // 4. Opt-in check via RLS-enforced read. Checked BEFORE host normalization
  // or any outbound fetch so opted-out users never trigger upstream traffic.
  const user = await withTenantRls(prisma, tenantId, (tx) =>
    tx.user.findUnique({
      where: { id: userId },
      select: { fetchFavicons: true },
    }),
  );
  if (user?.fetchFavicons !== true) {
    return forbidden();
  }

  // 5. Parse and validate query parameters
  const queryResult = parseQuery(req, faviconQuerySchema);
  if (!queryResult.ok) return queryResult.response;

  const { host: rawHost, size: sizeStr } = queryResult.data;
  const size = Number(sizeStr) as 32 | 64;

  const normalizedHost = normalizeFaviconHost(rawHost);
  if (!normalizedHost) {
    return validationError();
  }

  // 6. Cache-first lookup. Re-validate the MIME on the serving boundary too,
  // not just on ingestion: a cached SVG must never be re-served.
  const cached = await getCachedFavicon(normalizedHost, size);
  if (cached && isAllowedFaviconMime(cached.contentType)) {
    return faviconResponse(cached.body, cached.contentType);
  }
  if (cached) {
    return new NextResponse(null, {
      status: 204,
      headers: { "Cache-Control": `private, max-age=${SEC_PER_HOUR}` },
    });
  }

  // 7. Rate limit ONLY the cache-miss path — cache hits must not consume quota.
  const userRl = await userLimiter.check(`rl:favicon:${userId}`);
  if (!userRl.allowed) {
    return rateLimited(userRl.retryAfterMs);
  }
  const globalRl = await globalLimiter.check("rl:favicon:global");
  if (!globalRl.allowed) {
    return rateLimited(globalRl.retryAfterMs);
  }

  // 8. Single-flight upstream fetch: N concurrent misses → 1 outbound request
  const entry = await withSingleFlight(normalizedHost, size, async () => {
    const providerUrl = buildFaviconProviderUrl(normalizedHost, size);

    let result;
    try {
      result = await validateAndFetchBuffered(providerUrl, {
        maxBytes: FAVICON_MAX_BODY_BYTES,
      });
    } catch {
      // 3xx (redirect:"error"), network errors, timeout, over-cap → 204 fallback
      return null;
    }

    if (!result.ok) return null;

    if (!isAllowedFaviconMime(result.contentType)) return null;
    const ct = result.contentType as string;

    await setCachedFavicon(normalizedHost, size, result.body, ct);

    return { body: result.body, contentType: ct, expiresAt: 0 };
  });

  if (!entry) {
    return new NextResponse(null, {
      status: 204,
      headers: { "Cache-Control": `private, max-age=${SEC_PER_HOUR}` },
    });
  }

  return faviconResponse(entry.body, entry.contentType);
}

export const GET = withRequestLog(handleGET);
