import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { createRateLimiter } from "@/lib/rate-limit";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, unauthorized } from "@/lib/api-response";
import { HIBP_RATE_MAX, RATE_WINDOW_MS } from "@/lib/validations/common.server";

export const runtime = "nodejs";

const PREFIX_REGEX = /^[0-9A-F]{5}$/;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 5_000;

type CacheEntry = { expiresAt: number; body: string };

const cache = new Map<string, CacheEntry>();

const hibpLimiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: HIBP_RATE_MAX });

// GET /api/watchtower/hibp?prefix=ABCDE
// Proxies HIBP k-Anonymity range API. Requires auth.
async function handleGET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  if (!(await hibpLimiter.check(`rl:hibp:${session.user.id}`)).allowed) {
    return errorResponse(API_ERROR.RATE_LIMIT_EXCEEDED, 429);
  }

  const { searchParams } = new URL(request.url);
  const prefix = (searchParams.get("prefix") || "").toUpperCase();
  if (!PREFIX_REGEX.test(prefix)) {
    return errorResponse(API_ERROR.INVALID_PREFIX, 400);
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

  const res = await fetch(
    `https://api.pwnedpasswords.com/range/${prefix}`,
    {
      headers: { "Add-Padding": "true" },
    }
  );

  if (!res.ok) {
    return errorResponse(API_ERROR.UPSTREAM_ERROR, 502);
  }

  const text = await res.text();
  // Evict stale entries when cache grows too large
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const now2 = Date.now();
    for (const [k, v] of cache) {
      if (v.expiresAt < now2) cache.delete(k);
    }
    // If still over limit after eviction, clear all
    if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
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
