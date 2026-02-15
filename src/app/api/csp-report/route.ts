import { NextResponse } from "next/server";
import { withRequestLog } from "@/lib/with-request-log";
import { getLogger } from "@/lib/logger";

export const runtime = "nodejs";

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
const rate = new Map<string, { resetAt: number; count: number }>();

// POST /api/csp-report
// Receives CSP violation reports.
async function handlePOST(request: Request) {
  const now = Date.now();
  const ip =
    request.headers.get("x-forwarded-for") ??
    request.headers.get("x-real-ip") ??
    "unknown";
  const entry = rate.get(ip);
  if (!entry || entry.resetAt < now) {
    rate.set(ip, { resetAt: now + RATE_WINDOW_MS, count: 1 });
  } else if (entry.count >= RATE_MAX) {
    return new NextResponse(null, { status: 204 });
  } else {
    entry.count += 1;
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (
    contentType.includes("application/csp-report") ||
    contentType.includes("application/reports+json")
  ) {
    const body = await request.json().catch(() => null);
    // Log for observability; avoid throwing
    if (body) {
      getLogger().warn({ cspReport: body }, "csp.violation");
    }
  }

  return new NextResponse(null, { status: 204 });
}

export const POST = withRequestLog(handlePOST);
