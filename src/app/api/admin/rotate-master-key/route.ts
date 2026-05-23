/**
 * POST /api/admin/rotate-master-key  →  410 Gone (A04-4)
 *
 * The single-actor rotation endpoint was replaced by a dual-approval flow:
 *   POST /api/admin/rotate-master-key/initiate
 *   POST /api/admin/rotate-master-key/[rotationId]/approve
 *   POST /api/admin/rotate-master-key/[rotationId]/execute
 *   POST /api/admin/rotate-master-key/[rotationId]/revoke
 *
 * Pre-1.0 break is licensed by FR8 in the A04-4 plan. The 410 response
 * carries a body that points operators at the new endpoints — easier to
 * diagnose than a bare 404.
 */
import { NextRequest, NextResponse } from "next/server";
import { withRequestLog } from "@/lib/http/with-request-log";
import { getLogger } from "@/lib/logger";

async function handlePOST(req: NextRequest) {
  // Surface legacy hits to ops — operators still pointing scripts here need
  // to update their tooling. Best-effort, no auth check (the 410 itself is
  // the answer).
  getLogger().warn(
    { ua: req.headers.get("user-agent") ?? null },
    "legacy /api/admin/rotate-master-key hit (410 Gone — see replacedBy in response)",
  );
  return NextResponse.json(
    {
      error: "MASTER_KEY_ROTATION_LEGACY_GONE",
      message:
        "The single-actor master-key rotation endpoint has been replaced by a dual-approval flow.",
      replacedBy: {
        initiate: "/api/admin/rotate-master-key/initiate",
        approve: "/api/admin/rotate-master-key/[rotationId]/approve",
        execute: "/api/admin/rotate-master-key/[rotationId]/execute",
        revoke: "/api/admin/rotate-master-key/[rotationId]/revoke",
      },
    },
    { status: 410 },
  );
}

export const POST = withRequestLog(handlePOST);
