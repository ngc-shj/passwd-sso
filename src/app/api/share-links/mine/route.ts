import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, handleAuthError, unauthorized, validationError } from "@/lib/http/api-response";
import { requireTeamMember } from "@/lib/auth/access/team-auth";
import { TEAM_ROLE, SHARE_TYPE } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/http/with-request-log";
import { isValidCursorId } from "@/lib/audit/audit-query";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { displayUserOf, fetchUserDisplayMap } from "@/lib/audit/audit-user-lookup";

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
    return validationError();
  }
  const teamId = searchParams.get("team");
  const cursor = searchParams.get("cursor");
  if (!isValidCursorId(cursor)) {
    return errorResponse(API_ERROR.INVALID_CURSOR);
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
      where.shareType = { in: [SHARE_TYPE.TEXT, SHARE_TYPE.FILE] };
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
        // The creator is hydrated below, outside the tenant context. In the team
        // context this lists other members' shares, and a creator who has since
        // left has a users row RLS hides here — the REQUIRED relation came back
        // null (Prisma does not throw) and dereferencing it failed the whole page.
        include: {
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
    return errorResponse(API_ERROR.INVALID_CURSOR);
  }

  const hasMore = shares.length > limit;
  const items = hasMore ? shares.slice(0, limit) : shares;
  const nextCursor = hasMore ? items[items.length - 1].id : null;
  const creators = await fetchUserDisplayMap(
    items.map((s) => s.createdById),
    BYPASS_PURPOSE.CROSS_TENANT_LOOKUP,
  );
  const sharedByOf = (userId: string) => {
    const creator = displayUserOf(creators, userId);
    return creator.name?.trim() || creator.email || null;
  };

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
      sharedBy: sharedByOf(s.createdById),
      canRevoke: s.createdById === session.user.id,
      isActive:
        !s.revokedAt &&
        s.expiresAt > now &&
        (s.maxViews === null || s.viewCount < s.maxViews),
    })),
    nextCursor,
  });
}

export const GET = withRequestLog(handleGET);
