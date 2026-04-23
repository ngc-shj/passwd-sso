import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { withRequestLog } from "@/lib/with-request-log";
import { rateLimited, unauthorized } from "@/lib/api-response";
import { MS_PER_MINUTE } from "@/lib/constants/time";

export const runtime = "nodejs";

const WATCHTOWER_SCAN_COOLDOWN_MS = 5 * MS_PER_MINUTE;
const scanLimiter = createRateLimiter({
  windowMs: WATCHTOWER_SCAN_COOLDOWN_MS,
  max: 1,
});

// POST /api/watchtower/start
// Enforces per-user cooldown for full watchtower scans.
async function handlePOST() {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const rl = await scanLimiter.check(`rl:watchtower:start:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  return NextResponse.json({ ok: true });
}

export const POST = withRequestLog(handlePOST);
