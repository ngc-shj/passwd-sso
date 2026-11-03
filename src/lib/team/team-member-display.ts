import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";

/**
 * Input shape consumed by `buildTeamMemberDisplayItems`.
 *
 * Only the four fields below are read by the helper. Plan C1 listed
 * `keyDistributed` and `deactivatedAt` as inputs in spirit, but no consumer
 * needs them — list/update routes already filter on `deactivatedAt: null`,
 * and `keyDistributed` lives on `teamMemberKey`, not `teamMember`. See
 * `team-guest-cross-tenant-admin-deviation.md` for the recorded deviation.
 */
export interface TeamMemberDisplayRow {
  id: string;
  userId: string;
  role: string;
  createdAt: Date;
  /** The membership ended with the user's departure from the tenant (members GET only). */
  departed?: boolean;
  /**
   * A SCIM admission waiting for a key-holding team OWNER/ADMIN to approve or
   * reject it (scim-team-admission-approval, C5). Listed to MEMBER_INVITE
   * holders only — members GET.
   */
  pendingApproval?: boolean;
}

export interface TeamMemberDisplayItem {
  id: string;
  userId: string;
  role: string;
  name: string | null;
  email: string | null;
  image: string | null;
  joinedAt: Date;
  tenantName: string | null;
  departed: boolean;
  pendingApproval: boolean;
  /**
   * A pending row whose user is no longer an active member of the team's own
   * tenant (inactive or absent there) — approve always 409s on it, so the UI
   * hides Approve and offers only Reject. Meaningless off a pending row.
   */
  pendingTenantInactive: boolean;
}

/**
 * Same shape as `TeamMemberDisplayItem` but with `joinedAt` as the JSON
 * string the API serializes Date to. Use this on the client side to type
 * `members` arrays parsed from `GET /api/teams/[teamId]/members`.
 */
export type TeamMemberDisplayApiItem = Omit<TeamMemberDisplayItem, "joinedAt"> & {
  joinedAt: string;
};

/**
 * Hydrate display fields for team members outside team-tenant RLS so guest
 * users from a different primary tenant remain visible in team management UIs.
 */
export async function buildTeamMemberDisplayItems(
  members: TeamMemberDisplayRow[],
  // The team's own tenant, for `pendingTenantInactive` below. Omitted by
  // callers that never pass a pending row (the single-member and ownerless
  // routes) — `pendingTenantInactive` is then always false, which is correct
  // since those rows are never pending.
  teamTenantId?: string,
): Promise<TeamMemberDisplayItem[]> {
  const userIds = members.map((m) => m.userId);
  if (userIds.length === 0) {
    return [];
  }

  const [users, userTenants] = await withBypassRls(prisma, async (tx) => {
    const users = await tx.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true, image: true },
    });
    // The single-active-tenant invariant is enforced at the write boundary
    // (`resolveUserTenantIdFromClient`) — order by `createdAt` to keep the
    // chosen membership stable if the invariant is ever transiently violated.
    const userTenants = await tx.tenantMember.findMany({
      where: { userId: { in: userIds }, deactivatedAt: null },
      select: { userId: true, tenantId: true, tenant: { select: { name: true } } },
      // `createdAt` is not unique, so it alone does not make the choice
      // stable — the `id` tiebreak is what does (owning-tenant-rule.ts).
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return [users, userTenants] as const;
  },
  BYPASS_GRANT.TEAM_MEMBER_DISPLAY_LOOKUP);

  const userById = new Map(users.map((u) => [u.id, u]));
  const tenantByUserId = new Map(userTenants.map((t) => [t.userId, t.tenant.name]));
  // The same question approve asks: does this user hold an active
  // tenantMember row specifically in the TEAM's own tenant? A last-wins Map
  // keyed only by userId would answer a different question — "which one
  // active tenant does this user have" — and silently pick the wrong one
  // for a user active in two tenants at once (the single-active-tenant
  // invariant only momentarily violated, same caveat as the ordering above).
  const activeInTeamTenantUserIds = new Set(
    userTenants.filter((t) => t.tenantId === teamTenantId).map((t) => t.userId),
  );

  return members.flatMap((member) => {
    const user = userById.get(member.userId);
    if (!user) {
      return [];
    }
    const pendingApproval = member.pendingApproval ?? false;
    if (pendingApproval && teamTenantId === undefined) {
      // Every caller that can hand back a pending row also knows its own
      // tenantId (members GET) — an omission here is a caller bug, not a
      // state this predictor should guess at.
      throw new Error("buildTeamMemberDisplayItems: a pending row needs teamTenantId");
    }
    return [{
      id: member.id,
      userId: member.userId,
      role: member.role,
      name: user.name,
      email: user.email,
      image: user.image,
      joinedAt: member.createdAt,
      tenantName: tenantByUserId.get(member.userId) ?? null,
      departed: member.departed ?? false,
      pendingApproval,
      pendingTenantInactive: pendingApproval
        ? !activeInTeamTenantUserIds.has(member.userId)
        : false,
    }];
  });
}
