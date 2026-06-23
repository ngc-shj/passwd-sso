import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { validateAndFetch } from "@/lib/http/external-http";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { parseQuery } from "@/lib/http/parse-body";
import { unauthorized, rateLimited } from "@/lib/http/api-response";
import { withRequestLog } from "@/lib/http/with-request-log";
import { RATE_WINDOW_MS } from "@/lib/validations/common.server";
import {
  normalizeFaviconHost,
  buildFaviconProviderUrl,
  getCachedFavicon,
  setCachedFavicon,
  withSingleFlight,
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
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
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
    return NextResponse.json({ error: "VALIDATION_ERROR" }, { status: 400 });
  }

  // Cache-first lookup
  const cached = await getCachedFavicon(normalizedHost, size);
  if (cached) {
    return faviconResponse(cached.body, cached.contentType);
  }

  // Single-flight upstream fetch: N concurrent misses → 1 outbound request
  const entry = await withSingleFlight(normalizedHost, size, async () => {
    const providerUrl = buildFaviconProviderUrl(normalizedHost, size);

    let res: Response;
    try {
      res = await validateAndFetch(providerUrl, {});
    } catch {
      // Includes 3xx (redirect:"error") and network errors → 204 fallback
      return null;
    }

    if (!res.ok) return null;

    const ct = res.headers.get("content-type") ?? "";
    if (!ct.startsWith("image/")) return null;

    const buf = await res.arrayBuffer();
    if (buf.byteLength > FAVICON_MAX_BODY_BYTES) {
      // Over per-entry byte cap — treat as no favicon, do not cache
      return null;
    }

    const body = Buffer.from(buf);
    // Populate cache for subsequent requests
    await setCachedFavicon(normalizedHost, size, body, ct);

    return { body, contentType: ct, expiresAt: 0 };
  });

  if (!entry) {
    return new NextResponse(null, {
      status: 204,
      headers: { "Cache-Control": "private, max-age=3600" },
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
      "Cache-Control": "private, max-age=86400",
      ETag: etag,
    },
  });
}

export const GET = withRequestLog(handleGET);
