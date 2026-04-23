import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, handleAuthError, unauthorized } from "@/lib/api-response";
import { requireTeamMember } from "@/lib/auth/team-auth";
import { TEAM_ROLE } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import { isValidCursorId } from "@/lib/audit-query";

// GET /api/share-links/mine
// - Personal context (no `team`): links created by current user, personal entries only
// - Team context (`team` present): all links in the team
async function handleGET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status"); // "active" | "expired" | "revoked" | null (all)
  const shareType = searchParams.get("shareType"); // "entry" | "send" | null (all)
  if (shareType && shareType !== "entry" && shareType !== "send") {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }
  const teamId = searchParams.get("team");
  const cursor = searchParams.get("cursor");
  if (!isValidCursorId(cursor)) {
    return errorResponse(API_ERROR.INVALID_CURSOR, 400);
  }
  const limit = 30;

  const where: Record<string, unknown> = {};
  if (teamId) {
    let membershipRole: string | undefined;
    try {
      const membership = await requireTeamMember(session.user.id, teamId);
      membershipRole = membership.role;
    } catch (e) {
      return handleAuthError(e);
    }
    // Send is personal-only — team context never returns Send items
    if (shareType === "send") {
      return NextResponse.json({ items: [], nextCursor: null });
    }
    where.teamPasswordEntry = { teamId: teamId };
    // VIEWER can only see links they created. Higher roles can view team-wide links.
    if (membershipRole === TEAM_ROLE.VIEWER) {
      where.createdById = session.user.id;
    }
  } else {
    // Personal context
    where.createdById = session.user.id;
    if (shareType === "entry") {
      where.passwordEntryId = { not: null };
    } else if (shareType === "send") {
      where.shareType = { in: ["TEXT", "FILE"] };
    }
    // "all" or null: personal entries + sends, exclude team shares (shown in team context)
    if (!shareType || (shareType !== "entry" && shareType !== "send")) {
      where.teamPasswordEntryId = null;
    }
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
    shares = await withUserTenantRls(session.user.id, async () =>
      prisma.passwordShare.findMany({
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
          teamPasswordEntry: {
            select: { id: true, team: { select: { name: true } } },
          },
        },
      }),
    );
  } catch {
    return errorResponse(API_ERROR.INVALID_CURSOR, 400);
  }

  const hasMore = shares.length > limit;
  const items = hasMore ? shares.slice(0, limit) : shares;
  const nextCursor = hasMore ? items[items.length - 1].id : null;

  return NextResponse.json({
    items: items.map((s) => ({
      id: s.id,
      entryType: s.entryType,
      shareType: s.shareType,
      sendName: s.sendName,
      sendFilename: s.sendFilename,
      sendSizeBytes: s.sendSizeBytes,
      expiresAt: s.expiresAt,
      maxViews: s.maxViews,
      viewCount: s.viewCount,
      revokedAt: s.revokedAt,
      createdAt: s.createdAt,
      passwordEntryId: s.passwordEntryId,
      teamPasswordEntryId: s.teamPasswordEntryId,
      teamName: s.teamPasswordEntry?.team?.name ?? null,
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

export const GET = withRequestLog(handleGET);
