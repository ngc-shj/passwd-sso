import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

// GET /api/share-links/mine — List all share links created by the current user
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status"); // "active" | "expired" | "revoked" | null (all)
  const cursor = searchParams.get("cursor");
  const limit = 30;

  const where: Record<string, unknown> = {
    createdById: session.user.id,
  };

  const now = new Date();
  if (status === "active") {
    where.revokedAt = null;
    where.expiresAt = { gt: now };
  } else if (status === "expired") {
    where.revokedAt = null;
    where.expiresAt = { lte: now };
  } else if (status === "revoked") {
    where.revokedAt = { not: null };
  }

  const shares = await prisma.passwordShare.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      passwordEntry: {
        select: { id: true },
      },
      orgPasswordEntry: {
        select: { id: true, org: { select: { name: true } } },
      },
    },
  });

  const hasMore = shares.length > limit;
  const items = hasMore ? shares.slice(0, limit) : shares;
  const nextCursor = hasMore ? items[items.length - 1].id : null;

  return NextResponse.json({
    items: items.map((s) => ({
      id: s.id,
      entryType: s.entryType,
      expiresAt: s.expiresAt,
      maxViews: s.maxViews,
      viewCount: s.viewCount,
      revokedAt: s.revokedAt,
      createdAt: s.createdAt,
      passwordEntryId: s.passwordEntryId,
      orgPasswordEntryId: s.orgPasswordEntryId,
      orgName: s.orgPasswordEntry?.org?.name ?? null,
      hasPersonalEntry: !!s.passwordEntry,
      isActive:
        !s.revokedAt &&
        s.expiresAt > now &&
        (s.maxViews === null || s.viewCount < s.maxViews),
    })),
    nextCursor,
  });
}
