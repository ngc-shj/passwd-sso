import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { createRateLimiter } from "@/lib/rate-limit";
import { withRequestLog } from "@/lib/with-request-log";

export const runtime = "nodejs";

const WATCHTOWER_SCAN_COOLDOWN_MS = 5 * 60 * 1000;
const scanLimiter = createRateLimiter({
  windowMs: WATCHTOWER_SCAN_COOLDOWN_MS,
  max: 1,
});

// POST /api/watchtower/start
// Enforces per-user cooldown for full watchtower scans.
async function handlePOST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { allowed } = await scanLimiter.check(`rl:watchtower:start:${session.user.id}`);
  if (!allowed) {
    return NextResponse.json(
      {
        error: API_ERROR.RATE_LIMIT_EXCEEDED,
      },
      { status: 429 }
    );
  }

  return NextResponse.json({ ok: true });
}

export const POST = withRequestLog(handlePOST);
