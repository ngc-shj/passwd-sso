import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, rateLimited, unauthorized } from "@/lib/http/api-response";
import { HIBP_RATE_MAX, RATE_WINDOW_MS } from "@/lib/validations/common.server";
import { MS_PER_MINUTE, MS_PER_SECOND } from "@/lib/constants/time";

export const runtime = "nodejs";

const PREFIX_REGEX = /^[0-9A-F]{5}$/;
const CACHE_TTL_MS = 5 * MS_PER_MINUTE;
const FETCH_TIMEOUT_MS = 10 * MS_PER_SECOND;
const MAX_CACHE_ENTRIES = 5_000;

type CacheEntry = { expiresAt: number; body: string };

// TODO: When migrating to Redis, unify with proxy.ts session cache
// to share a single Redis connection and TTL management strategy.
const cache = new Map<string, CacheEntry>();

const hibpLimiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: HIBP_RATE_MAX });

// GET /api/watchtower/hibp?prefix=ABCDE
// Proxies HIBP k-Anonymity range API. Requires auth.
async function handleGET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const rl = await hibpLimiter.check(`rl:hibp:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const { searchParams } = new URL(request.url);
  const prefix = (searchParams.get("prefix") || "").toUpperCase();
  if (!PREFIX_REGEX.test(prefix)) {
    return errorResponse(API_ERROR.INVALID_PREFIX);
  }

  const now = Date.now();
  const cached = cache.get(prefix);
  if (cached && cached.expiresAt > now) {
    return new NextResponse(cached.body, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "private, max-age=300",
      },
    });
  }

  let res: Response;
  try {
    res = await fetch(
      `https://api.pwnedpasswords.com/range/${prefix}`,
      {
        headers: { "Add-Padding": "true" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );
  } catch (err) {
    // AbortSignal.timeout throws a TimeoutError (name === "TimeoutError") on expiry,
    // or an AbortError on manual abort. Both map to upstream failure.
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return errorResponse(API_ERROR.UPSTREAM_ERROR);
    }
    throw err;
  }

  if (!res.ok) {
    return errorResponse(API_ERROR.UPSTREAM_ERROR);
  }

  const text = await res.text();
  // Evict stale entries when cache grows too large
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const now2 = Date.now();
    for (const [k, v] of cache) {
      if (v.expiresAt < now2) cache.delete(k);
    }
    // Still over limit: evict oldest-inserted entries (Map preserves insertion
    // order) instead of clearing the whole cache — a full clear() would let a
    // single scan wipe every co-tenant's hot prefixes at once.
    while (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }
  cache.set(prefix, { expiresAt: now + CACHE_TTL_MS, body: text });
  return new NextResponse(text, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, max-age=300",
    },
  });
}

export const GET = withRequestLog(handleGET);
