import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { validateAndFetchBuffered } from "@/lib/http/external-http";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { parseQuery } from "@/lib/http/parse-body";
import { unauthorized, rateLimited, forbidden, validationError } from "@/lib/http/api-response";
import { withRequestLog } from "@/lib/http/with-request-log";
import { RATE_WINDOW_MS } from "@/lib/validations/common.server";
import { SEC_PER_DAY, SEC_PER_HOUR } from "@/lib/constants/time";
import {
  normalizeFaviconHost,
  buildFaviconProviderUrl,
  getCachedFavicon,
  setCachedFavicon,
  withSingleFlight,
  isAllowedFaviconMime,
  FAVICON_MAX_BODY_BYTES,
} from "@/lib/favicon/favicon-proxy";

export const runtime = "nodejs";

const FAVICON_USER_RATE_MAX = 120;
const FAVICON_GLOBAL_RATE_MAX = 5_000;

const faviconQuerySchema = z.object({
  host: z.string(),
  size: z.enum(["32", "64"]),
});

// Fail-open limiters: favicon is a cosmetic feature — a Redis blip must not 503.
const userLimiter = createRateLimiter({
  windowMs: RATE_WINDOW_MS,
  max: FAVICON_USER_RATE_MAX,
});

const globalLimiter = createRateLimiter({
  windowMs: RATE_WINDOW_MS,
  max: FAVICON_GLOBAL_RATE_MAX,
});

// GET /api/user/favicon?host=<host>&size=<32|64>
async function handleGET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  // Enforce opt-in preference before any normalization or fetch.
  // Server-side enforcement of the privacy contract: even a rogue/stale
  // client cannot trigger an outbound fetch for an opted-out user.
  if (session.user.fetchFavicons !== true) {
    return forbidden();
  }

  // Per-user rate limit
  const userRl = await userLimiter.check(`rl:favicon:${session.user.id}`);
  if (!userRl.allowed) {
    return rateLimited(userRl.retryAfterMs);
  }

  // Global rate limit
  const globalRl = await globalLimiter.check("rl:favicon:global");
  if (!globalRl.allowed) {
    return rateLimited(globalRl.retryAfterMs);
  }

  const queryResult = parseQuery(req, faviconQuerySchema);
  if (!queryResult.ok) return queryResult.response;

  const { host: rawHost, size: sizeStr } = queryResult.data;
  const size = Number(sizeStr) as 32 | 64;

  const normalizedHost = normalizeFaviconHost(rawHost);
  if (!normalizedHost) {
    return validationError();
  }

  // Cache-first lookup. Re-validate the MIME on the SERVING boundary too, not
  // just on ingestion: an SVG seeded by the pre-allowlist code (or any future
  // cache poisoning) must never be re-served same-origin. NG → 204 (browser
  // falls back to the globe).
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

  // Single-flight upstream fetch: N concurrent misses → 1 outbound request
  const entry = await withSingleFlight(normalizedHost, size, async () => {
    const providerUrl = buildFaviconProviderUrl(normalizedHost, size);

    let result;
    try {
      // Buffered variant reads the body before the pinned dispatcher is
      // destroyed; the plain validateAndFetch would surface ClientDestroyedError
      // when the body is read after it returns. maxBytes enforces the byte cap.
      result = await validateAndFetchBuffered(providerUrl, {
        maxBytes: FAVICON_MAX_BODY_BYTES,
      });
    } catch {
      // 3xx (redirect:"error"), network errors, timeout, over-cap → 204 fallback
      return null;
    }

    if (!result.ok) return null;

    // Allow only inert raster/icon MIME types — never image/svg+xml. SVG is
    // active content and these responses carry no CSP/X-Frame headers, so a
    // same-origin SVG opened directly would execute script in the app origin.
    if (!isAllowedFaviconMime(result.contentType)) return null;
    const ct = result.contentType as string;

    // Populate cache for subsequent requests
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

// Build a 200 image response. Copies the favicon bytes into a fresh, exact-size
// ArrayBuffer — Buffer.from(base64) / Buffer.from(arrayBuffer) may return a view
// onto Node's shared 64 KB pool, so `body.buffer` would leak unrelated pool bytes
// (and other requests' data) into the response. Slice by offset/length to copy
// exactly this favicon.
function faviconResponse(body: Buffer, contentType: string): NextResponse {
  // Copy into a fresh exact-size Uint8Array. body.buffer may be Node's shared
  // 64 KB pool (Buffer.from(base64) is pool-backed), so passing body.buffer
  // would leak unrelated pool bytes — including other requests' data — past the
  // favicon. Uint8Array.from copies exactly body.byteLength bytes.
  const exact = Uint8Array.from(body);
  const etag = `W/"${body.toString("base64").slice(0, 32)}"`;
  return new NextResponse(exact, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": `private, max-age=${SEC_PER_DAY}`,
      ETag: etag,
    },
  });
}

export const GET = withRequestLog(handleGET);
