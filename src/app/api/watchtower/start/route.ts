import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { withRequestLog } from "@/lib/http/with-request-log";
import { rateLimited, unauthorized } from "@/lib/http/api-response";
import { WATCHTOWER_COOLDOWN_MS } from "@/lib/constants/timing";

export const runtime = "nodejs";

const scanLimiter = createRateLimiter({
  windowMs: WATCHTOWER_COOLDOWN_MS,
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
