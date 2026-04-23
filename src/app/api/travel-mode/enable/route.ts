import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { AUDIT_ACTION } from "@/lib/constants";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
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

  await logAuditAsync({
    ...personalAuditBase(request, session.user.id),
    action: AUDIT_ACTION.TRAVEL_MODE_ENABLE,
  });

  return NextResponse.json({ active: true });
}

export const POST = withRequestLog(handlePOST);
