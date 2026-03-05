import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";

export const runtime = "nodejs";

/**
 * GET /api/travel-mode
 * Return the current travel mode state for the authenticated user.
 */
async function handleGET(_request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const user = await withUserTenantRls(session.user.id, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        travelModeActive: true,
        travelModeActivatedAt: true,
      },
    }),
  );

  if (!user) {
    return NextResponse.json({ error: API_ERROR.USER_NOT_FOUND }, { status: 404 });
  }

  return NextResponse.json({
    active: user.travelModeActive,
    activatedAt: user.travelModeActivatedAt,
  });
}

export const GET = withRequestLog(handleGET);
