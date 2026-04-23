import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { withRequestLog } from "@/lib/http/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import { errorResponse, unauthorized } from "@/lib/http/api-response";

export const runtime = "nodejs";

/**
 * GET /api/travel-mode
 * Return the current travel mode state for the authenticated user.
 */
async function handleGET(_request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
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
    return errorResponse(API_ERROR.USER_NOT_FOUND, 404);
  }

  return NextResponse.json({
    active: user.travelModeActive,
    activatedAt: user.travelModeActivatedAt,
  });
}

export const GET = withRequestLog(handleGET);
