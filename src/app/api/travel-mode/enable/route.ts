import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { withRequestLog } from "@/lib/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import { unauthorized } from "@/lib/api-response";

export const runtime = "nodejs";

/**
 * POST /api/travel-mode/enable
 * Enable Travel Mode for the authenticated user.
 */
async function handlePOST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  await withUserTenantRls(session.user.id, async () =>
    prisma.user.update({
      where: { id: session.user.id },
      data: {
        travelModeActive: true,
        travelModeActivatedAt: new Date(),
      },
    }),
  );

  logAudit({
    action: AUDIT_ACTION.TRAVEL_MODE_ENABLE,
    scope: AUDIT_SCOPE.PERSONAL,
    userId: session.user.id,
    ...extractRequestMeta(request),
  });

  return NextResponse.json({ active: true });
}

export const POST = withRequestLog(handlePOST);
