import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { requireOrgMember, OrgAuthError } from "@/lib/org-auth";

// GET /api/share-links/mine
// - Personal context (no `org`): links created by current user, personal entries only
// - Org context (`org` present): all links in the organization
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status"); // "active" | "expired" | "revoked" | null (all)
  const orgId = searchParams.get("org");
  const cursor = searchParams.get("cursor");
  const limit = 30;

  const where: Record<string, unknown> = {};
  if (orgId) {
    try {
      await requireOrgMember(session.user.id, orgId);
    } catch (e) {
      if (e instanceof OrgAuthError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      throw e;
    }
    where.orgPasswordEntry = { orgId };
  } else {
    // Personal context: exclude organization share links.
    where.createdById = session.user.id;
    where.passwordEntryId = { not: null };
  }

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

  let shares;
  try {
    shares = await prisma.passwordShare.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        createdBy: {
          select: { id: true, name: true, email: true },
        },
        passwordEntry: {
          select: { id: true },
        },
        orgPasswordEntry: {
          select: { id: true, org: { select: { name: true } } },
        },
      },
    });
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_CURSOR }, { status: 400 });
  }

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
      sharedBy:
        s.createdBy.name?.trim() ||
        s.createdBy.email ||
        null,
      canRevoke: s.createdBy.id === session.user.id,
      isActive:
        !s.revokedAt &&
        s.expiresAt > now &&
        (s.maxViews === null || s.viewCount < s.maxViews),
    })),
    nextCursor,
  });
}
