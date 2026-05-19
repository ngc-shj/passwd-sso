import { prisma } from "@/lib/prisma";
import { BYPASS_PURPOSE, withBypassRls } from "@/lib/tenant-rls";

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
): Promise<TeamMemberDisplayItem[]> {
  const userIds = members.map((m) => m.userId);
  if (userIds.length === 0) {
    return [];
  }

  const [users, userTenants] = await withBypassRls(prisma, async (tx) =>
    Promise.all([
      tx.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, email: true, image: true },
      }),
      // The single-active-tenant invariant is enforced at the write boundary
      // (`resolveUserTenantIdFromClient`) — order by `createdAt` to keep the
      // chosen membership stable if the invariant is ever transiently violated.
      tx.tenantMember.findMany({
        where: { userId: { in: userIds }, deactivatedAt: null },
        select: { userId: true, tenant: { select: { name: true } } },
        orderBy: { createdAt: "asc" },
      }),
    ]),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  const userById = new Map(users.map((u) => [u.id, u]));
  const tenantByUserId = new Map(userTenants.map((t) => [t.userId, t.tenant.name]));

  return members.flatMap((member) => {
    const user = userById.get(member.userId);
    if (!user) {
      return [];
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
    }];
  });
}
