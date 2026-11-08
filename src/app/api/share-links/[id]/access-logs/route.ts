import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, unauthorized, notFound } from "@/lib/http/api-response";
import { withUserTenantRls } from "@/lib/tenant-context";
import { SHARE_LINK_MANAGER, shareLinkManagerOf } from "@/lib/share/share-link-manager";
import { withRequestLog } from "@/lib/http/with-request-log";
import { SHARE_ACCESS_LOG_LIMIT } from "@/lib/validations/common.server";
import { isValidCursorId } from "@/lib/audit/audit-query";

type Params = { params: Promise<{ id: string }> };

// GET /api/share-links/[id]/access-logs — List access logs for a share link
async function handleGET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { id } = await params;

  // The link's creator only: the log holds viewers' IP addresses and user
  // agents, which a team admin's revoke right (#995) does not extend to. A team
  // link's creator is held to the team's IP restriction.
  const share = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordShare.findUnique({
      where: { id },
      select: { createdById: true, teamPasswordEntry: { select: { teamId: true } } },
    }),
  );

  if (!share || (await shareLinkManagerOf(session.user.id, share, req)) !== SHARE_LINK_MANAGER.CREATOR) {
    return notFound();
  }

  const { searchParams } = new URL(req.url);
  const cursor = searchParams.get("cursor");
  if (!isValidCursorId(cursor)) {
    return errorResponse(API_ERROR.INVALID_CURSOR);
  }
  const limit = SHARE_ACCESS_LOG_LIMIT;

  let logs;
  try {
    logs = await withUserTenantRls(session.user.id, async () =>
      prisma.shareAccessLog.findMany({
        where: { shareId: id },
        orderBy: { createdAt: "desc" },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          ip: true,
          userAgent: true,
          createdAt: true,
        },
      }),
    );
  } catch {
    return errorResponse(API_ERROR.INVALID_CURSOR);
  }

  const hasMore = logs.length > limit;
  const items = hasMore ? logs.slice(0, limit) : logs;
  const nextCursor = hasMore ? items[items.length - 1].id : null;

  return NextResponse.json({ items, nextCursor });
}

export const GET = withRequestLog(handleGET);
