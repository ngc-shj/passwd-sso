import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { API_ERROR } from "@/lib/api-error-codes";

export const runtime = "nodejs";

const PREFIX_REGEX = /^[0-9A-F]{5}$/;
const CACHE_TTL_MS = 5 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 30;

type CacheEntry = { expiresAt: number; body: string };
type RateEntry = { resetAt: number; count: number };

const cache = new Map<string, CacheEntry>();
const rate = new Map<string, RateEntry>();

// GET /api/watchtower/hibp?prefix=ABCDE
// Proxies HIBP k-Anonymity range API. Requires auth.
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const rateKey = session.user.id;
  const now = Date.now();
  const rateEntry = rate.get(rateKey);
  if (!rateEntry || rateEntry.resetAt < now) {
    rate.set(rateKey, { resetAt: now + RATE_WINDOW_MS, count: 1 });
  } else if (rateEntry.count >= RATE_MAX) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 }
    );
  } else {
    rateEntry.count += 1;
  }

  const { searchParams } = new URL(request.url);
  const prefix = (searchParams.get("prefix") || "").toUpperCase();
  if (!PREFIX_REGEX.test(prefix)) {
    return NextResponse.json({ error: API_ERROR.INVALID_PREFIX }, { status: 400 });
  }

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
    return NextResponse.json({ error: API_ERROR.UPSTREAM_ERROR }, { status: 502 });
  }

  const text = await res.text();
  cache.set(prefix, { expiresAt: now + CACHE_TTL_MS, body: text });
  return new NextResponse(text, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, max-age=300",
    },
  });
}
