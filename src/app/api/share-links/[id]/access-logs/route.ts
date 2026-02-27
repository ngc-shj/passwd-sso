import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { withUserTenantRls } from "@/lib/tenant-context";

type Params = { params: Promise<{ id: string }> };

// GET /api/share-links/[id]/access-logs — List access logs for a share link
export async function GET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { id } = await params;

  // Verify the share link belongs to the current user
  const share = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordShare.findUnique({
      where: { id },
      select: { createdById: true },
    }),
  );

  if (!share || share.createdById !== session.user.id) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  const { searchParams } = new URL(req.url);
  const cursor = searchParams.get("cursor");
  const limit = 50;

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
    return NextResponse.json({ error: API_ERROR.INVALID_CURSOR }, { status: 400 });
  }

  const hasMore = logs.length > limit;
  const items = hasMore ? logs.slice(0, limit) : logs;
  const nextCursor = hasMore ? items[items.length - 1].id : null;

  return NextResponse.json({ items, nextCursor });
}
